using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using System.Data.Common;
using System.Text.Json;

var expectedAdj = new Dictionary<string, HashSet<string>>
{
    ["a"] = new() { "b" },
    ["b"] = new() { "a" },
};

var counter = new QueryCounterInterceptor();
using var connection = new SqliteConnection("DataSource=:memory:");
connection.Open();

var options = new DbContextOptionsBuilder<ProbeDbContext>()
    .UseSqlite(connection)
    .AddInterceptors(counter)
    .Options;

using var db = new ProbeDbContext(options);
db.Database.EnsureCreated();

var a = new Node { Name = "a" };
var b = new Node { Name = "b" };
a.Dependencies.Add(b);
b.Dependencies.Add(a);
db.Nodes.AddRange(a, b);
db.SaveChanges();

var roots = db.Nodes
    .Where(n => n.Name == "a" || n.Name == "b")
    .Include(n => n.Dependencies)
    .ThenInclude(n => n.Dependencies)
    .OrderBy(n => n.Name)
    .ToList();

var queriesAfterHydration = counter.QueryCount;

foreach (var root in roots)
{
    foreach (var dep in root.Dependencies)
    {
        _ = dep.Dependencies.Count;
    }
}

var queryGatePass = counter.QueryCount == queriesAfterHydration;
var queryGate = new
{
    pass = queryGatePass,
    reason = queryGatePass ? (string?)null : $"expected no additional queries during traversal, saw +{counter.QueryCount - queriesAfterHydration}",
};

var graphCheck = SmartCheck(roots, expectedAdj);
var hydration = (queryGate.pass && graphCheck.pass) ? "HYDRATION PASS" : "HYDRATION FAIL";

var serialization = "SERIALIZE_PASS";
try
{
    JsonSerializer.Serialize(roots);
}
catch (Exception ex)
{
    var msg = ex.Message.ToLowerInvariant();
    serialization = (msg.Contains("cycle") || msg.Contains("circular") || msg.Contains("recursion"))
        ? "SERIALIZE_FAIL_CYCLE"
        : "SERIALIZE_FAIL_OTHER";
}

Console.WriteLine("dotnet Program.cs");
Console.WriteLine($"hydration: {hydration}");
Console.WriteLine($"queryGate: {JsonSerializer.Serialize(queryGate)}");
Console.WriteLine($"smartCheck: {JsonSerializer.Serialize(graphCheck)}");
Console.WriteLine($"serialization: {serialization}");

static object SmartCheck(List<Node> roots, Dictionary<string, HashSet<string>> expectedAdj)
{
    var stack = new Stack<Node>(roots);
    var visited = new HashSet<Node>();
    var byName = new Dictionary<string, Node>();
    var edges = 0;

    while (stack.Count > 0)
    {
        var node = stack.Pop();
        if (!visited.Add(node)) continue;

        if (byName.TryGetValue(node.Name, out var prior) && !ReferenceEquals(prior, node))
        {
            return new { pass = false, reason = $"id \"{node.Name}\" maps to multiple in-memory instances", uniqueIds = byName.Count, uniqueInstances = visited.Count, edgesTraversed = edges };
        }

        byName[node.Name] = node;
        var actual = node.Dependencies.Select(dep => dep.Name).ToHashSet();
        var expected = expectedAdj.TryGetValue(node.Name, out var deps) ? deps : new HashSet<string>();
        if (!actual.SetEquals(expected))
        {
            return new { pass = false, reason = $"dependency closure mismatch at \"{node.Name}\"", uniqueIds = byName.Count, uniqueInstances = visited.Count, edgesTraversed = edges };
        }

        foreach (var dep in node.Dependencies)
        {
            edges += 1;
            stack.Push(dep);
        }
    }

    if (byName.Count != expectedAdj.Count)
    {
        return new { pass = false, reason = $"reachable ids mismatch: got {byName.Count}, expected {expectedAdj.Count}", uniqueIds = byName.Count, uniqueInstances = visited.Count, edgesTraversed = edges };
    }

    return new { pass = true, reason = (string?)null, uniqueIds = byName.Count, uniqueInstances = visited.Count, edgesTraversed = edges };
}

public class ProbeDbContext(DbContextOptions<ProbeDbContext> options) : DbContext(options)
{
    public DbSet<Node> Nodes => Set<Node>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Node>()
            .HasMany(n => n.Dependencies)
            .WithMany(n => n.Dependents)
            .UsingEntity("NodeDependencies");

        modelBuilder.Entity<Node>().HasIndex(n => n.Name).IsUnique();
    }
}

public class Node
{
    public int Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public List<Node> Dependencies { get; set; } = [];
    public List<Node> Dependents { get; set; } = [];
}

public sealed class QueryCounterInterceptor : DbCommandInterceptor
{
    public int QueryCount { get; private set; }

    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        QueryCount += 1;
        return base.ReaderExecuting(command, eventData, result);
    }
}
