import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import jakarta.persistence.*;
import org.hibernate.cfg.AvailableSettings;
import org.hibernate.cfg.Configuration;
import org.hibernate.resource.jdbc.spi.StatementInspector;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class Main {
  private static final AtomicInteger QUERY_COUNT = new AtomicInteger(0);

  public static void main(String[] args) throws Exception {
    var expectedAdj = Map.of("a", Set.of("b"), "b", Set.of("a"));
    var findings = createDefaultFindings();

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

      int extraQueries = QUERY_COUNT.get() - queriesAfterHydration;
      if (extraQueries == 0) {
        findings.queryGate = mapOf("detail", "No additional queries observed during traversal.", "result", "PASS");
      } else {
        findings.queryGate = mapOf(
          "detail", "Expected 0 additional queries during traversal, observed " + extraQueries + ".",
          "extraQueries", extraQueries,
          "result", "FAIL"
        );
      }

      var graphCheck = smartCheck(roots, expectedAdj);
      if (Boolean.TRUE.equals(graphCheck.get("pass"))) {
        findings.smartCheck = mapOf("detail", "Identity and dependency closure checks passed.", "result", "PASS");
      } else {
        findings.smartCheck = mapOf("detail", graphCheck.get("reason"), "result", "FAIL");
      }

      if ("PASS".equals(findings.queryGate.get("result")) && "PASS".equals(findings.smartCheck.get("result"))) {
        findings.hydration = mapOf("detail", "Hydration check passed.", "result", "PASS");
      } else {
        findings.hydration = mapOf(
          "detail", "Hydration failed: queryGate=" + findings.queryGate.get("result") + ", smartCheck=" + findings.smartCheck.get("result") + ".",
          "result", "FAIL"
        );
      }

      try {
        new ObjectMapper().writeValueAsString(roots);
        findings.serialize = mapOf("detail", "JSON serialization passed.", "result", "SERIALIZE_PASS");
      } catch (Exception e) {
        var msg = (e.getMessage() == null ? "" : e.getMessage()).toLowerCase(Locale.ROOT);
        var serialization = (msg.contains("cycle") || msg.contains("circular") || msg.contains("recursion"))
          ? "SERIALIZE_FAIL_CYCLE"
          : "SERIALIZE_FAIL_OTHER";
        findings.serialize = mapOf("detail", stackDetail(e), "result", serialization);
      }
    } catch (Exception e) {
      var detail = stackDetail(e);
      findings.hydration = mapOf("detail", detail, "result", "FAIL");
      findings.queryGate = mapOf("detail", detail, "result", "FAIL");
      findings.smartCheck = mapOf("detail", detail, "result", "FAIL");
      findings.serialize = mapOf("detail", detail, "result", "SERIALIZE_FAIL_OTHER");
    }

    var result = new TreeMap<String, Object>();
    result.put("findings", findings.toMap());
    result.put("language", "java");
    result.put("library", "Hibernate");
    result.put("libraryVersion", hibernateVersionFromPom());
    result.put("outcome", buildOutcome(findings));
    result.put("probe", "hibernate");
    result.put("runtimeVersion", System.getProperty("java.version"));

    var outputPath = writeResult(result, "hibernate");

    System.out.println("java Main");
    System.out.println("hydration: " + ("PASS".equals(findings.hydration.get("result")) ? "HYDRATION PASS" : "HYDRATION FAIL"));
    System.out.println("queryGate: " + findings.queryGate);
    System.out.println("smartCheck: " + findings.smartCheck);
    System.out.println("serialization: " + findings.serialize.get("result"));
    System.out.println("json: " + outputPath);
  }

  // Keep this rollup logic in sync with supporting-probes/ts/result-builder.ts::buildOutcome.
  private static String buildOutcome(Findings findings) {
    if ("FAIL".equals(findings.hydration.get("result"))) {
      return "HYDRATION_FAIL";
    }

    var serializeResult = String.valueOf(findings.serialize.get("result"));
    if (serializeResult.startsWith("SERIALIZE_FAIL_")) {
      return "SERIALIZE_FAIL";
    }

    boolean allPassed =
      "PASS".equals(findings.hydration.get("result")) &&
      "PASS".equals(findings.queryGate.get("result")) &&
      "PASS".equals(findings.smartCheck.get("result")) &&
      "SERIALIZE_PASS".equals(findings.serialize.get("result"));

    return allPassed ? "PASS" : "MIXED";
  }

  private static Findings createDefaultFindings() {
    var findings = new Findings();
    findings.hydration = mapOf("detail", "", "result", "FAIL");
    findings.queryGate = mapOf("detail", "", "result", "FAIL");
    findings.smartCheck = mapOf("detail", "", "result", "FAIL");
    findings.serialize = mapOf("detail", "", "result", "SERIALIZE_FAIL_OTHER");
    return findings;
  }

  private static String hibernateVersionFromPom() {
    try {
      var pom = Files.readString(Path.of("pom.xml"), StandardCharsets.UTF_8);
      var pattern = Pattern.compile("<artifactId>hibernate-core</artifactId>\\s*<version>([^<]+)</version>", Pattern.MULTILINE);
      Matcher matcher = pattern.matcher(pom);
      if (matcher.find()) {
        return matcher.group(1).trim();
      }
    } catch (IOException ignored) {
      // fall through
    }
    return "unknown";
  }

  private static String writeResult(Map<String, Object> result, String probeName) throws IOException {
    var runId = System.getenv("PROBE_RUN_ID");
    if (runId == null || runId.isBlank()) {
      throw new IllegalStateException("PROBE_RUN_ID is required for probe JSON output");
    }

    var outputDir = Path.of("results", "local", runId);
    Files.createDirectories(outputDir);

    var outputPath = outputDir.resolve(probeName + ".json");
    var tmpPath = outputDir.resolve(probeName + ".json.tmp");

    var mapper = new ObjectMapper();
    mapper.enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
    mapper.enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY);
    var payload = mapper.writerWithDefaultPrettyPrinter().writeValueAsString(result) + "\n";
    Files.writeString(tmpPath, payload, StandardCharsets.UTF_8);
    try {
      Files.move(tmpPath, outputPath, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    } catch (IOException ignored) {
      Files.move(tmpPath, outputPath, StandardCopyOption.REPLACE_EXISTING);
    }

    return outputPath.toString();
  }

  private static LinkedHashMap<String, Object> mapOf(Object... kv) {
    var map = new LinkedHashMap<String, Object>();
    for (int i = 0; i < kv.length; i += 2) {
      map.put(String.valueOf(kv[i]), kv[i + 1]);
    }
    return map;
  }

  private static String stackDetail(Throwable error) {
    var sw = new StringWriter();
    error.printStackTrace(new PrintWriter(sw));
    var lines = sw.toString().split("\\R");
    var maxLines = Math.min(lines.length, 13);
    var sb = new StringBuilder();
    for (int i = 0; i < maxLines; i++) {
      sb.append(lines[i]);
      if (i + 1 < maxLines) {
        sb.append(System.lineSeparator());
      }
    }
    return sb.toString();
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
        return mapOf("pass", false, "reason", "id \"" + node.getName() + "\" maps to multiple in-memory instances");
      }

      byName.put(node.getName(), node);
      var actual = new HashSet<String>();
      for (var dep : node.getDependencies()) {
        actual.add(dep.getName());
      }
      var expected = expectedAdj.getOrDefault(node.getName(), Set.of());
      if (!actual.equals(expected)) {
        return mapOf("pass", false, "reason", "dependency closure mismatch at \"" + node.getName() + "\"");
      }

      for (var dep : node.getDependencies()) {
        edges += 1;
        stack.push(dep);
      }
    }

    if (byName.size() != expectedAdj.size()) {
      return mapOf("pass", false, "reason", "reachable ids mismatch: got " + byName.size() + ", expected " + expectedAdj.size());
    }

    return mapOf("pass", true, "reason", null);
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

  private static final class Findings {
    private LinkedHashMap<String, Object> hydration;
    private LinkedHashMap<String, Object> queryGate;
    private LinkedHashMap<String, Object> smartCheck;
    private LinkedHashMap<String, Object> serialize;

    private Map<String, Object> toMap() {
      var map = new TreeMap<String, Object>();
      map.put("hydration", hydration);
      map.put("queryGate", queryGate);
      map.put("serialize", serialize);
      map.put("smartCheck", smartCheck);
      return map;
    }
  }
}
