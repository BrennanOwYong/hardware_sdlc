import Link from "next/link";

export default function HomePage() {
  return (
    <>
      <h1>Forge</h1>
      <p className="muted">
        Vibe coding for hardware: see your parts, get guided through wiring,
        and version every working build.
      </p>
      <div style={{ margin: "1rem 0" }}>
        <Link href="/assemble?demo=auto" className="btn btn-primary">
          Run 90-second demo
        </Link>
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Ctrl-F for real life</h2>
          <p className="muted">
            Photograph your workspace and get a named part inventory you can
            search; ask for a part and Forge highlights it in the photo.
          </p>
          <Link href="/inventory" className="btn">
            Open Inventory
          </Link>
        </div>
        <div className="card">
          <h2>Guided assembly</h2>
          <p className="muted">
            Live video watches each wire: touch the right target, hear
            &quot;Correct - push it in now&quot;, and firmware is generated from
            the pins Forge observed.
          </p>
          <Link href="/assemble" className="btn">
            Open Assemble
          </Link>
        </div>
        <div className="card">
          <h2>Git for hardware</h2>
          <p className="muted">
            Every working state becomes a commit with photo, netlist, and
            firmware hash; diff builds, roll back, or fork a variant.
          </p>
          <Link href="/timeline" className="btn">
            Open Timeline
          </Link>
        </div>
      </div>
    </>
  );
}
