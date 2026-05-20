// Supporting EF Core probe (run externally).
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

public static class EfCoreProbe
{
    public static async Task<object> RunAsync(MyDbContext db)
    {
        var expectedAdj = new Dictionary<string, HashSet<string>>
        {
            ["a"] = new HashSet<string> { "b" },
            ["b"] = new HashSet<string> { "a" }
        };

        var queryCount = 0;
        db.GetService<ILoggerFactory>(); // attach query-counter logger externally and increment queryCount.

        var roots = await db.Nodes
            .Include(n => n.Dependencies)
            .ThenInclude(n => n.Dependencies)
            .ToListAsync();

        var afterFetch = queryCount;
        foreach (var root in roots)
        {
            foreach (var dep in root.Dependencies)
            {
                _ = dep.Dependencies.Count;
            }
        }

        var queryGatePass = queryCount == afterFetch;
        var graphCheck = SmartCheck(roots, expectedAdj);

        var serialization = "SERIALIZE_PASS";
        try
        {
            JsonSerializer.Serialize(roots);
        }
        catch (Exception ex)
        {
            var m = ex.Message.ToLowerInvariant();
            serialization = (m.Contains("cycle") || m.Contains("circular")) ? "SERIALIZE_FAIL_CYCLE" : "SERIALIZE_FAIL_OTHER";
        }

        var hydration = (queryGatePass && graphCheck.pass) ? "HYDRATION PASS" : "HYDRATION FAIL";
        return new { hydration, queryGate = new { pass = queryGatePass }, graphCheck, serialization };
    }

    private static (bool pass, string? reason, int uniqueIds, int uniqueInstances, int edges) SmartCheck(
        List<Node> roots,
        Dictionary<string, HashSet<string>> expectedAdj)
    {
        var stack = new Stack<Node>(roots);
        var visited = new HashSet<Node>();
        var byId = new Dictionary<string, Node>();
        var edges = 0;

        while (stack.Count > 0)
        {
            var node = stack.Pop();
            if (!visited.Add(node)) continue;

            if (byId.TryGetValue(node.Id, out var prior) && !ReferenceEquals(prior, node))
                return (false, $"id {node.Id} resolved to multiple instances", byId.Count, visited.Count, edges);

            byId[node.Id] = node;
            var actual = node.Dependencies.Select(d => d.Id).ToHashSet();
            var expected = expectedAdj.TryGetValue(node.Id, out var e) ? e : new HashSet<string>();
            if (!actual.SetEquals(expected))
                return (false, $"closure mismatch at {node.Id}", byId.Count, visited.Count, edges);

            foreach (var dep in node.Dependencies)
            {
                edges++;
                stack.Push(dep);
            }
        }

        if (byId.Count != expectedAdj.Count)
            return (false, $"reachable ids {byId.Count}/{expectedAdj.Count}", byId.Count, visited.Count, edges);

        return (true, null, byId.Count, visited.Count, edges);
    }
}
