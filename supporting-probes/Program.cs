using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using System.Data.Common;
using System.Collections;
using System.Reflection;
using System.Text.Json;

var expectedAdj = new Dictionary<string, HashSet<string>>
{
    ["a"] = new() { "b" },
    ["b"] = new() { "c" },
    ["c"] = new(),
};

var findings = new Findings
{
    Hydration = new Dictionary<string, object?> { ["detail"] = string.Empty, ["result"] = "FAIL" },
    QueryGate = new Dictionary<string, object?> { ["detail"] = string.Empty, ["result"] = "FAIL" },
    SmartCheck = new Dictionary<string, object?> { ["detail"] = string.Empty, ["result"] = "FAIL" },
    Serialize = new Dictionary<string, object?> { ["detail"] = string.Empty, ["result"] = "SERIALIZE_FAIL_OTHER" },
};

(int reached, int expected, int edges, int extraQueries, bool identityStable)? metrics = null;

try
{
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
    var c = new Node { Name = "c" };
    a.Dependencies.Add(b);
    b.Dependencies.Add(c);
    db.Nodes.AddRange(a, b, c);
    db.SaveChanges();

    var roots = db.Nodes
        .Where(n => n.Name == "a")
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

    var extraQueries = counter.QueryCount - queriesAfterHydration;
    findings.QueryGate = extraQueries == 0
        ? new Dictionary<string, object?> { ["detail"] = "No additional queries observed during traversal.", ["result"] = "PASS" }
        : new Dictionary<string, object?>
        {
            ["detail"] = $"Expected 0 additional queries during traversal, observed {extraQueries}.",
            ["extraQueries"] = extraQueries,
            ["result"] = "FAIL",
        };

    var graphCheck = SmartCheck(roots, expectedAdj);
    metrics = (graphCheck.reached, expectedAdj.Count, graphCheck.edges, extraQueries, !graphCheck.reason.Contains("multiple in-memory instances"));
    findings.SmartCheck = graphCheck.pass
        ? new Dictionary<string, object?> { ["detail"] = "Identity and dependency closure checks passed.", ["result"] = "PASS" }
        : new Dictionary<string, object?> { ["detail"] = graphCheck.reason, ["result"] = "FAIL" };

    findings.Hydration = (string)findings.QueryGate["result"]! == "PASS" && (string)findings.SmartCheck["result"]! == "PASS"
        ? new Dictionary<string, object?> { ["detail"] = "Hydration check passed.", ["result"] = "PASS" }
        : new Dictionary<string, object?>
        {
            ["detail"] = $"Hydration failed: queryGate={findings.QueryGate["result"]}, smartCheck={findings.SmartCheck["result"]}.",
            ["result"] = "FAIL",
        };

    try
    {
        JsonSerializer.Serialize(roots);
        findings.Serialize = new Dictionary<string, object?> { ["detail"] = "JSON serialization passed.", ["result"] = "SERIALIZE_PASS" };
    }
    catch (Exception ex)
    {
        var msg = ex.Message.ToLowerInvariant();
        var serialization = (msg.Contains("cycle") || msg.Contains("circular") || msg.Contains("recursion"))
            ? "SERIALIZE_FAIL_CYCLE"
            : "SERIALIZE_FAIL_OTHER";
        findings.Serialize = new Dictionary<string, object?> { ["detail"] = FormatExceptionDetail(ex), ["result"] = serialization };
    }
}
catch (Exception ex)
{
    var detail = FormatExceptionDetail(ex);
    findings.Hydration = new Dictionary<string, object?> { ["detail"] = detail, ["result"] = "FAIL" };
    findings.QueryGate = new Dictionary<string, object?> { ["detail"] = detail, ["result"] = "FAIL" };
    findings.SmartCheck = new Dictionary<string, object?> { ["detail"] = detail, ["result"] = "FAIL" };
    findings.Serialize = new Dictionary<string, object?> { ["detail"] = detail, ["result"] = "SERIALIZE_FAIL_OTHER" };
}

var efVersion = typeof(DbContext).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0]
    ?? typeof(DbContext).Assembly.GetName().Version?.ToString()
    ?? "unknown";

var result = new Dictionary<string, object?>
{
    ["probe"] = "efcore",
    ["language"] = "csharp",
    ["library"] = "EF Core",
    ["libraryVersion"] = efVersion,
    ["runtimeVersion"] = Environment.Version.ToString(),
    ["findings"] = new Dictionary<string, object?>
    {
        ["hydration"] = findings.Hydration,
        ["queryGate"] = findings.QueryGate,
        ["smartCheck"] = findings.SmartCheck,
        ["serialize"] = findings.Serialize,
    },
};

result["outcome"] = BuildOutcome(findings);
var outputPath = WriteResult(result, "efcore");

PrintReport(
    "efcore",
    "EF Core",
    efVersion,
    "db.Nodes.Where(n=>n.Name==\"a\") <- .AutoInclude() on Dependencies navigation (schema default)",
    findings,
    outputPath,
    metrics);

// Keep this rollup logic in sync with supporting-probes/ts/result-builder.ts::buildOutcome.
static string BuildOutcome(Findings findings)
{
    if (Equals(findings.Hydration["result"], "FAIL"))
    {
        return "HYDRATION_FAIL";
    }

    var serializeResult = findings.Serialize["result"]?.ToString() ?? string.Empty;
    if (serializeResult.StartsWith("SERIALIZE_FAIL_", StringComparison.Ordinal))
    {
        return "SERIALIZE_FAIL";
    }

    var allPassed =
        Equals(findings.Hydration["result"], "PASS") &&
        Equals(findings.QueryGate["result"], "PASS") &&
        Equals(findings.SmartCheck["result"], "PASS") &&
        Equals(findings.Serialize["result"], "SERIALIZE_PASS");

    return allPassed ? "PASS" : "MIXED";
}

static string WriteResult(Dictionary<string, object?> result, string probeName)
{
    var runId = Environment.GetEnvironmentVariable("PROBE_RUN_ID");
    if (string.IsNullOrWhiteSpace(runId))
    {
        runId = $"{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-nogit";
    }

    var outputDir = Path.Combine(Directory.GetCurrentDirectory(), "results", "local", runId);
    Directory.CreateDirectory(outputDir);

    var outputPath = Path.Combine(outputDir, $"{probeName}.json");
    var tmpPath = $"{outputPath}.tmp";

    var sorted = SortObject(result);
    var json = JsonSerializer.Serialize(sorted, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;
    File.WriteAllText(tmpPath, json);
    File.Move(tmpPath, outputPath, true);

    return outputPath;
}

static object? SortObject(object? value)
{
    if (value is Dictionary<string, object?> dict)
    {
        var sorted = new SortedDictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (key, val) in dict)
        {
            sorted[key] = SortObject(val);
        }

        return sorted;
    }

    if (value is IEnumerable list && value is not string)
    {
        var output = new List<object?>();
        foreach (var item in list)
        {
            output.Add(SortObject(item));
        }
        return output;
    }

    return value;
}

static string FormatExceptionDetail(Exception ex)
{
    var stackLines = (ex.StackTrace ?? string.Empty)
        .Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries)
        .Take(12);
    var stackTop = string.Join(Environment.NewLine, stackLines);
    return $"{ex.GetType().Name}: {ex.Message}{Environment.NewLine}{stackTop}".TrimEnd();
}

static (bool pass, string reason, int reached, int edges) SmartCheck(List<Node> roots, Dictionary<string, HashSet<string>> expectedAdj)
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
            return (false, $"id \"{node.Name}\" maps to multiple in-memory instances", byName.Count, edges);
        }

        byName[node.Name] = node;
        var actual = node.Dependencies.Select(dep => dep.Name).ToHashSet();
        var expected = expectedAdj.TryGetValue(node.Name, out var deps) ? deps : new HashSet<string>();
        if (!actual.SetEquals(expected))
        {
            return (false, $"dependency closure mismatch at \"{node.Name}\"", byName.Count, edges);
        }

        foreach (var dep in node.Dependencies)
        {
            edges += 1;
            stack.Push(dep);
        }
    }

    return byName.Count != expectedAdj.Count
        ? (false, $"reachable ids mismatch: got {byName.Count}, expected {expectedAdj.Count}", byName.Count, edges)
        : (true, string.Empty, byName.Count, edges);
}

static void PrintReport(
    string probe,
    string library,
    string libraryVersion,
    string strategy,
    Findings findings,
    string jsonPath,
    (int reached, int expected, int edges, int extraQueries, bool identityStable)? metrics)
{
    const int ruleWidth = 64;
    const string scenario = "acyclic A->B->C | schema-driven full hydration (no query-time include paths)";

    static string Rule(string label, int width)
    {
        var prefix = $"== {label} ";
        return prefix + new string('=', Math.Max(0, width - prefix.Length));
    }

    static string FirstLine(object? detail)
    {
        var line = (detail?.ToString() ?? string.Empty).Split('\n')[0].Trim();
        return line.Length > 100 ? line[..99] + "..." : line;
    }

    static (string verdict, string reason) DeriveVerdict(Findings f)
    {
        if (Equals(f.Hydration["result"], "PASS"))
        {
            return Equals(f.Serialize["result"], "SERIALIZE_PASS")
                ? ("ACYCLIC_PASS", "schema-driven full hydration + serialization succeeded")
                : ("ACYCLIC_PASS", $"full hydration succeeded; serialization {f.Serialize["result"]}");
        }

        var exceptionRaised =
            Equals(f.QueryGate["result"], "FAIL") &&
            Equals(f.SmartCheck["result"], "FAIL") &&
            Equals(f.Hydration["detail"]?.ToString(), f.SmartCheck["detail"]?.ToString()) &&
            Equals(f.SmartCheck["detail"]?.ToString(), f.QueryGate["detail"]?.ToString());
        if (exceptionRaised)
        {
            return ("ACYCLIC_FAIL", $"probe raised before traversal -- {FirstLine(f.Hydration["detail"])}");
        }
        if (Equals(f.SmartCheck["result"], "FAIL"))
        {
            return ("ACYCLIC_FAIL", $"smartCheck failed -- {FirstLine(f.SmartCheck["detail"])}");
        }
        if (Equals(f.QueryGate["result"], "FAIL"))
        {
            return ("ACYCLIC_FAIL", $"topology resolved but queryGate failed -- {FirstLine(f.QueryGate["detail"])}");
        }
        return ("ACYCLIC_FAIL", "hydration failed");
    }

    static string ObservedLine((int reached, int expected, int edges, int extraQueries, bool identityStable)? m)
    {
        if (m is null)
        {
            return "observed : n/a -- probe raised before the traversal stage";
        }
        var v = m.Value;
        var parts = new List<string>
        {
            $"reached {v.reached}/{v.expected} expected nodes from root [a]",
            $"{v.edges} edges",
            v.identityStable ? "identity stable" : "identity BROKEN (duplicate instances)",
            $"{v.extraQueries} extra queries",
        };
        return "observed : " + string.Join("; ", parts);
    }

    var (verdict, reason) = DeriveVerdict(findings);
    string Pad(object? result) => (result?.ToString() ?? string.Empty).PadRight(4);

    Console.WriteLine();
    Console.WriteLine(Rule($"{probe} | {library} v{libraryVersion}", ruleWidth));
    Console.WriteLine($"scenario : {scenario}");
    Console.WriteLine($"strategy : {strategy}");
    Console.WriteLine(ObservedLine(metrics));
    Console.WriteLine($"  hydration  : {Pad(findings.Hydration["result"])}  {FirstLine(findings.Hydration["detail"])}");
    Console.WriteLine($"  queryGate  : {Pad(findings.QueryGate["result"])}  {FirstLine(findings.QueryGate["detail"])}");
    Console.WriteLine($"  smartCheck : {Pad(findings.SmartCheck["result"])}  {FirstLine(findings.SmartCheck["detail"])}");
    Console.WriteLine($"  serialize  : {findings.Serialize["result"]}  {FirstLine(findings.Serialize["detail"])}");
    Console.WriteLine($"VERDICT  : {verdict} -- {reason}");
    Console.WriteLine($"json     : {jsonPath}");
}

internal sealed class Findings
{
    public required Dictionary<string, object?> Hydration { get; set; }
    public required Dictionary<string, object?> QueryGate { get; set; }
    public required Dictionary<string, object?> SmartCheck { get; set; }
    public required Dictionary<string, object?> Serialize { get; set; }
}

public class ProbeDbContext(DbContextOptions<ProbeDbContext> options) : DbContext(options)
{
    public DbSet<Node> Nodes => Set<Node>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Node>()
            .HasMany(n => n.Dependencies)
            .WithMany(n => n.Dependents);

        modelBuilder.Entity<Node>()
            .Navigation(n => n.Dependencies)
            .AutoInclude();

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
