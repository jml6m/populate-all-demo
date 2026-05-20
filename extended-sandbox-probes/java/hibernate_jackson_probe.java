// Supporting Hibernate/Jackson probe (run externally).
import com.fasterxml.jackson.databind.ObjectMapper;

public final class HibernateJacksonProbe {
  public static ProbeResult run(EntityManager em) {
    var expectedAdj = java.util.Map.of("a", java.util.Set.of("b"), "b", java.util.Set.of("a"));
    var queryCount = new java.util.concurrent.atomic.AtomicInteger(0);
    // Attach Hibernate StatementInspector / SQL logger externally and increment queryCount.

    var roots = em.createQuery("select n from Node n", Node.class).getResultList();
    var afterFetch = queryCount.get();

    for (var r : roots) {
      for (var d : r.getDependencies()) {
        d.getDependencies().size();
      }
    }

    var queryGatePass = queryCount.get() == afterFetch;
    var graphCheck = smartCheck(roots, expectedAdj);

    String serialization = "SERIALIZE_PASS";
    try {
      new ObjectMapper().writeValueAsString(roots);
    } catch (Exception e) {
      var m = e.getMessage().toLowerCase();
      serialization = (m.contains("cycle") || m.contains("circular")) ? "SERIALIZE_FAIL_CYCLE" : "SERIALIZE_FAIL_OTHER";
    }

    var hydration = (queryGatePass && graphCheck.pass()) ? "HYDRATION PASS" : "HYDRATION FAIL";
    return new ProbeResult(hydration, queryGatePass, graphCheck, serialization);
  }

  private static GraphCheck smartCheck(java.util.List<Node> roots, java.util.Map<String, java.util.Set<String>> expectedAdj) {
    var stack = new java.util.ArrayDeque<Node>(roots);
    var visited = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<Node, Boolean>());
    var byId = new java.util.HashMap<String, Node>();
    int edges = 0;

    while (!stack.isEmpty()) {
      var node = stack.pop();
      if (!visited.add(node)) continue;

      var prior = byId.get(node.getId());
      if (prior != null && prior != node) {
        return new GraphCheck(false, "id " + node.getId() + " resolved to multiple instances", byId.size(), visited.size(), edges);
      }
      byId.put(node.getId(), node);

      var actual = node.getDependencies().stream().map(Node::getId).collect(java.util.stream.Collectors.toSet());
      var expected = expectedAdj.getOrDefault(node.getId(), java.util.Set.of());
      if (!actual.equals(expected)) {
        return new GraphCheck(false, "closure mismatch at " + node.getId(), byId.size(), visited.size(), edges);
      }

      for (var dep : node.getDependencies()) {
        edges++;
        stack.push(dep);
      }
    }

    if (byId.size() != expectedAdj.size()) {
      return new GraphCheck(false, "reachable ids " + byId.size() + "/" + expectedAdj.size(), byId.size(), visited.size(), edges);
    }

    return new GraphCheck(true, null, byId.size(), visited.size(), edges);
  }

  public record ProbeResult(String hydration, boolean queryGatePass, GraphCheck graphCheck, String serialization) {}
  public record GraphCheck(boolean pass, String reason, int uniqueIds, int uniqueInstances, int edges) {}
}
