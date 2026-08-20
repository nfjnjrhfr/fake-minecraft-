// Checks the recommendation maths without a browser:  node docs/logic.test.mjs
// The functions are pulled straight out of index.html so the test can never
// drift from the code that actually ships.
import fs from "node:fs";
const html = fs.readFileSync("docs/index.html", "utf8");
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Pull out just the pure functions, without the DOM wiring.
const src = js.slice(js.indexOf("function tolerance"), js.indexOf("// ----", js.indexOf("function buildAdvice")));
const mod = new Function(src + "\nreturn { tolerance, rank, buildAdvice };")();

const R = (name, id) => ({ flag: "F", name, city: name, id });
const results = [
  { region: R("台灣", "tw"), ms: 12 },
  { region: R("日本", "jp"), ms: 38 },
  { region: R("香港", "hk"), ms: 45 },
  { region: R("新加坡", "sg"), ms: 70 },
  { region: R("美西", "usw"), ms: 140 },
  { region: R("德國", "de"), ms: 250 },
  { region: R("澳洲", "au"), ms: null },
];

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  [${ok ? "ok  " : "FAIL"}] ${label}${detail ? "  -- " + detail : ""}`);
};

console.log("tolerance window scales with bandwidth:");
for (const mbps of [0.5, 1, 5, 20, 50, 100, 500]) {
  console.log(`    ${String(mbps).padStart(5)} Mbps -> ±${mod.tolerance(mbps)} ms`);
}
check("slow link gives a narrow window", mod.tolerance(1) < 15, `${mod.tolerance(1)} ms`);
check("fast link gives a wide window", mod.tolerance(100) > 80, `${mod.tolerance(100)} ms`);
check("window is capped so it cannot grow forever",
      mod.tolerance(500) === mod.tolerance(100));
check("window never inverts ordering", mod.tolerance(0) > 0);

console.log("\nunreachable regions are excluded from ranking:");
const ranked = mod.rank(results);
check("null latency dropped", ranked.length === 6 && !ranked.some(e => e.ms === null));
check("sorted ascending", ranked.every((e, i) => i === 0 || ranked[i-1].ms <= e.ms));

console.log("\nrecommendation on a slow link (2 Mbps):");
const slow = mod.buildAdvice(2, results);
console.log("    pick:", slow.pick.region.name, "| usable:", slow.usable.map(e => e.region.name).join(", "));
check("slow link picks the nearest", slow.pick.region.id === "tw");
check("slow link keeps the set tight", slow.usable.length === 1);

console.log("\nrecommendation on a fast link (100 Mbps):");
const fast = mod.buildAdvice(100, results);
console.log("    pick:", fast.pick.region.name, "| usable:", fast.usable.map(e => e.region.name).join(", "));
check("fast link still picks the nearest as best", fast.pick.region.id === "tw");
check("fast link opens up more countries", fast.usable.length > slow.usable.length,
      `${fast.usable.length} vs ${slow.usable.length}`);
check("fast link still excludes the far ones", !fast.usable.some(e => e.region.id === "de"));

console.log("\nspeed test unreachable (null):");
const unknown = mod.buildAdvice(null, results);
console.log("    pick:", unknown.pick.region.name, "| usable:", unknown.usable.map(e => e.region.name).join(", "));
check("still recommends something", unknown.pick !== null);
check("falls back to a cautious window", unknown.usable.length <= mod.buildAdvice(50, results).usable.length);
check("says the speed test failed", /測速服務連不上/.test(unknown.html));

console.log("\nedge cases:");
const none = mod.buildAdvice(50, [{ region: R("x", "x"), ms: null }]);
check("all-unreachable produces a message, not a crash", none.pick === null);
check("all-unreachable still exposes an empty usable list", Array.isArray(none.usable));
check("both measurements failing is handled", mod.buildAdvice(null, [{ region: R("x", "x"), ms: null }]).pick === null);
const one = mod.buildAdvice(50, [{ region: R("只有一個", "only"), ms: 30 }]);
check("single region works", one.pick.region.id === "only" && one.usable.length === 1);
check("zero speed does not break the window", mod.buildAdvice(0, results).pick.region.id === "tw");

console.log(failures ? `\n${failures} check(s) failed` : "\nall logic checks passed");
process.exit(failures ? 1 : 0);
