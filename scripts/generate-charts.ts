/**
 * generate-charts.ts
 *
 * Generates chart images for the experiment analysis report.
 * Outputs PNG files to analysis/figures/.
 *
 * Usage: npm run charts
 */

import { ChartConfiguration } from 'chart.js';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Benchmark data (Benchmark #1, CI run: ubuntu-latest, Node 22, 4 GB heap)
// 250K graph: 250,000 nodes, 500,181 edges
// ---------------------------------------------------------------------------

const TIERS = ['basic (10)', 'medium (5K)', 'stress (50K)', 'extreme (250K)'];
const TIER_NODES = [10, 5000, 50000, 250000];

// null = algorithm failed (stack overflow) at that tier
const TIME_MS: Record<string, (number | null)[]> = {
  'Map Tracker': [0.3, 13, null, null],
  'Tarjan SCC': [0.8, 46, 277, 2360],
  'Two-Pass Wire': [0.2, 13, 67, 502],
};

const MEMORY_MB: Record<string, (number | null)[]> = {
  'Map Tracker': [0.0, 3.0, null, null],
  'Tarjan SCC': [0.1, 9.2, 14.8, 149],
  'Two-Pass Wire': [0.0, 2.9, 7.4, 54],
};

// Colors consistent across charts
const COLORS: Record<string, string> = {
  'Map Tracker': 'rgba(255, 159, 64, 0.85)',
  'Tarjan SCC': 'rgba(54, 162, 235, 0.85)',
  'Two-Pass Wire': 'rgba(75, 192, 100, 0.85)',
};

const BORDER_COLORS: Record<string, string> = {
  'Map Tracker': 'rgba(255, 159, 64, 1)',
  'Tarjan SCC': 'rgba(54, 162, 235, 1)',
  'Two-Pass Wire': 'rgba(75, 192, 100, 1)',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OUT_DIR = path.resolve(__dirname, '..', 'analysis', 'figures');

function ensureOutDir(): void {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
}

async function renderChart(
  filename: string,
  config: ChartConfiguration,
  width = 900,
  height = 500,
): Promise<void> {
  const canvas = new ChartJSNodeCanvas({ width, height, backgroundColour: 'white' });
  const buffer = await canvas.renderToBuffer(config);
  const outPath = path.join(OUT_DIR, filename);
  fs.writeFileSync(outPath, buffer);
  console.log(`  ✓ ${outPath}`);
}

// ---------------------------------------------------------------------------
// Chart 1 — time-by-tier.png
// Grouped bar chart: X = tier, grouped bars per algorithm (passing only)
// Logarithmic Y-axis
// ---------------------------------------------------------------------------

async function generateTimeByTier(): Promise<void> {
  const datasets = Object.entries(TIME_MS).map(([algo, values]) => ({
    label: algo,
    data: values.map((v) => v ?? 0),
    backgroundColor: COLORS[algo],
    borderColor: BORDER_COLORS[algo],
    borderWidth: 1,
    // Use 0 for failed tiers so they don't break the bar chart layout;
    // the subtitle clarifies that 0 represents a stack-overflow failure.
  }));

  const config: ChartConfiguration = {
    type: 'bar',
    data: {
      labels: TIERS,
      datasets,
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: 'Execution Time by Dataset Tier',
          font: { size: 16 },
        },
        subtitle: {
          display: true,
          text: 'Passing algorithms only — failed tiers (stack overflow) shown as 0',
          font: { size: 12 },
        },
        legend: { position: 'top' },
      },
      scales: {
        y: {
          type: 'logarithmic',
          title: { display: true, text: 'Time (ms) — log scale' },
          min: 0.1,
        },
        x: {
          title: { display: true, text: 'Dataset Tier' },
        },
      },
    },
  };

  await renderChart('time-by-tier.png', config);
}

// ---------------------------------------------------------------------------
// Chart 2 — scaling-curve.png
// Line chart: X = node count (log), Y = time (ms, log)
// Tarjan SCC + Two-Pass Wire only (only algorithms that pass stress + extreme)
// ---------------------------------------------------------------------------

async function generateScalingCurve(): Promise<void> {
  const algos = ['Tarjan SCC', 'Two-Pass Wire'];

  const datasets = algos.map((algo) => {
    const times = TIME_MS[algo];
    // Only include tiers where the algorithm passes
    const points = TIER_NODES.map((x, i) => ({ x, y: times[i] as number })).filter(
      (p) => p.y !== null,
    );
    return {
      label: algo,
      data: points,
      borderColor: BORDER_COLORS[algo],
      backgroundColor: COLORS[algo],
      fill: false,
      tension: 0.1,
      pointRadius: 5,
    };
  });

  const config: ChartConfiguration = {
    type: 'line',
    data: { datasets },
    options: {
      plugins: {
        title: {
          display: true,
          text: 'Scaling: Time vs Node Count',
          font: { size: 16 },
        },
        subtitle: {
          display: true,
          text: 'Tarjan SCC and Two-Pass Wire (only algorithms passing stress + extreme tiers)',
          font: { size: 12 },
        },
        legend: { position: 'top' },
      },
      scales: {
        x: {
          type: 'logarithmic',
          title: { display: true, text: 'Node Count (log scale)' },
        },
        y: {
          type: 'logarithmic',
          title: { display: true, text: 'Time (ms) — log scale' },
          min: 0.1,
        },
      },
    },
  };

  await renderChart('scaling-curve.png', config);
}

// ---------------------------------------------------------------------------
// Chart 3 — memory-comparison.png
// Grouped bar chart: stress + extreme tiers, Tarjan vs Two-Pass Wire
// ---------------------------------------------------------------------------

async function generateMemoryComparison(): Promise<void> {
  const tiers = ['stress (50K)', 'extreme (250K)'];
  const algos = ['Tarjan SCC', 'Two-Pass Wire'];
  const memSlice = [2, 3]; // indices in MEMORY_MB arrays for stress/extreme

  const datasets = algos.map((algo) => ({
    label: algo,
    data: memSlice.map((i) => MEMORY_MB[algo][i] as number),
    backgroundColor: COLORS[algo],
    borderColor: BORDER_COLORS[algo],
    borderWidth: 1,
  }));

  const config: ChartConfiguration = {
    type: 'bar',
    data: {
      labels: tiers,
      datasets,
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: 'Heap Delta: Tarjan SCC vs Two-Pass Wire',
          font: { size: 16 },
        },
        legend: { position: 'top' },
      },
      scales: {
        y: {
          title: { display: true, text: 'Heap Delta (MB)' },
          beginAtZero: true,
        },
        x: {
          title: { display: true, text: 'Dataset Tier' },
        },
      },
    },
  };

  await renderChart('memory-comparison.png', config);
}

// ---------------------------------------------------------------------------
// File 4 — algorithm-diagram.mmd (Mermaid source)
// Two-panel diagram: Pass 1 shell creation → Pass 2 edge wiring
// ---------------------------------------------------------------------------

function generateAlgorithmDiagram(): void {
  const mmd = `graph LR
  subgraph P1["Pass 1 — allocate shells"]
    A1["A { deps: [] }"]
    B1["B { deps: [] }"]
    C1["C { deps: [] }"]
    D1["D { deps: [] }"]
  end
  subgraph P2["Pass 2 — wire edges"]
    A2["A { deps: [B, C] }"]
    B2["B { deps: [D] }"]
    C2["C { deps: [A] }"]
    D2["D { deps: [B] }"]
    A2 --> B2
    A2 --> C2
    C2 --> A2
    B2 --> D2
    D2 --> B2
  end
  P1 -->|"Map lookup"| P2
`;

  const outPath = path.join(OUT_DIR, 'algorithm-diagram.mmd');
  fs.writeFileSync(outPath, mmd, 'utf-8');
  console.log(`  ✓ ${outPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Generating charts → analysis/figures/');
  ensureOutDir();

  await generateTimeByTier();
  await generateScalingCurve();
  await generateMemoryComparison();
  generateAlgorithmDiagram();

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
