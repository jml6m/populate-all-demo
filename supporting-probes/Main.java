import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.*;
import org.hibernate.cfg.AvailableSettings;
import org.hibernate.cfg.Configuration;
import org.hibernate.resource.jdbc.spi.StatementInspector;

import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

public final class Main {
  private static final AtomicInteger QUERY_COUNT = new AtomicInteger(0);

  public static void main(String[] args) {
    var expectedAdj = Map.of("a", Set.of("b"), "b", Set.of("a"));

    var configuration = new Configuration();
    configuration.setProperty(AvailableSettings.JAKARTA_JDBC_DRIVER, "org.h2.Driver");
    configuration.setProperty(AvailableSettings.JAKARTA_JDBC_URL, "jdbc:h2:mem:probe;DB_CLOSE_DELAY=-1");
    configuration.setProperty(AvailableSettings.HBM2DDL_AUTO, "create-drop");
    configuration.setProperty(AvailableSettings.SHOW_SQL, "false");
    configuration.setProperty(AvailableSettings.STATEMENT_INSPECTOR, QueryInspector.class.getName());
    configuration.addAnnotatedClass(Node.class);

    try (var sessionFactory = configuration.buildSessionFactory()) {
      try (var session = sessionFactory.openSession()) {
        var tx = session.beginTransaction();
        var a = new Node("a");
        var b = new Node("b");
        a.getDependencies().add(b);
        b.getDependencies().add(a);
        session.persist(a);
        session.persist(b);
        tx.commit();
      }

      List<Node> roots;
      try (var session = sessionFactory.openSession()) {
        roots = session.createQuery(
            "select distinct n from Node n " +
                "left join fetch n.dependencies d " +
                "left join fetch d.dependencies " +
                "where n.name in (:names)",
            Node.class)
          .setParameter("names", List.of("a", "b"))
          .getResultList();
      }

      int queriesAfterHydration = QUERY_COUNT.get();

      for (var root : roots) {
        for (var dep : root.getDependencies()) {
          dep.getDependencies().size();
        }
      }

      boolean queryGatePass = QUERY_COUNT.get() == queriesAfterHydration;
      var queryGate = new LinkedHashMap<String, Object>();
      queryGate.put("pass", queryGatePass);
      queryGate.put("reason", queryGatePass ? null : "expected no additional queries during traversal, saw +" + (QUERY_COUNT.get() - queriesAfterHydration));

      var graphCheck = smartCheck(roots, expectedAdj);
      boolean hydrationPass = queryGatePass && Boolean.TRUE.equals(graphCheck.get("pass"));
      var hydration = hydrationPass ? "HYDRATION PASS" : "HYDRATION FAIL";

      var serialization = "SERIALIZE_PASS";
      try {
        new ObjectMapper().writeValueAsString(roots);
      } catch (Exception e) {
        var msg = e.getMessage() == null ? "" : e.getMessage().toLowerCase(Locale.ROOT);
        serialization = (msg.contains("cycle") || msg.contains("circular") || msg.contains("recursion"))
          ? "SERIALIZE_FAIL_CYCLE"
          : "SERIALIZE_FAIL_OTHER";
      }

      System.out.println("java Main");
      System.out.println("hydration: " + hydration);
      System.out.println("queryGate: " + queryGate);
      System.out.println("smartCheck: " + graphCheck);
      System.out.println("serialization: " + serialization);
    }
  }

  private static Map<String, Object> smartCheck(List<Node> roots, Map<String, Set<String>> expectedAdj) {
    var stack = new ArrayDeque<>(roots);
    var visited = Collections.newSetFromMap(new IdentityHashMap<Node, Boolean>());
    var byName = new HashMap<String, Node>();
    int edges = 0;

    while (!stack.isEmpty()) {
      var node = stack.pop();
      if (!visited.add(node)) {
        continue;
      }

      var prior = byName.get(node.getName());
      if (prior != null && prior != node) {
        return Map.of("pass", false, "reason", "id \"" + node.getName() + "\" maps to multiple in-memory instances", "uniqueIds", byName.size(), "uniqueInstances", visited.size(), "edgesTraversed", edges);
      }

      byName.put(node.getName(), node);
      var actual = new HashSet<String>();
      for (var dep : node.getDependencies()) {
        actual.add(dep.getName());
      }
      var expected = expectedAdj.getOrDefault(node.getName(), Set.of());
      if (!actual.equals(expected)) {
        return Map.of("pass", false, "reason", "dependency closure mismatch at \"" + node.getName() + "\"", "uniqueIds", byName.size(), "uniqueInstances", visited.size(), "edgesTraversed", edges);
      }

      for (var dep : node.getDependencies()) {
        edges += 1;
        stack.push(dep);
      }
    }

    if (byName.size() != expectedAdj.size()) {
      return Map.of("pass", false, "reason", "reachable ids mismatch: got " + byName.size() + ", expected " + expectedAdj.size(), "uniqueIds", byName.size(), "uniqueInstances", visited.size(), "edgesTraversed", edges);
    }

    var passResult = new LinkedHashMap<String, Object>();
    passResult.put("pass", true);
    passResult.put("reason", null);
    passResult.put("uniqueIds", byName.size());
    passResult.put("uniqueInstances", visited.size());
    passResult.put("edgesTraversed", edges);
    return passResult;
  }

  public static class QueryInspector implements StatementInspector {
    @Override
    public String inspect(String sql) {
      QUERY_COUNT.incrementAndGet();
      return sql;
    }
  }

  @Entity(name = "Node")
  @Table(name = "nodes")
  public static class Node {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(unique = true, nullable = false)
    private String name;

    @ManyToMany
    @JoinTable(name = "node_dependencies",
      joinColumns = @JoinColumn(name = "node_id"),
      inverseJoinColumns = @JoinColumn(name = "dependency_id"))
    private Set<Node> dependencies = new HashSet<>();

    @ManyToMany(mappedBy = "dependencies")
    private Set<Node> dependents = new HashSet<>();

    public Node() {}

    public Node(String name) {
      this.name = name;
    }

    public String getName() {
      return name;
    }

    public Set<Node> getDependencies() {
      return dependencies;
    }
  }
}
