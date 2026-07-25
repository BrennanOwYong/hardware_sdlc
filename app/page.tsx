import Link from "next/link";

// Four features, and only four. Anything not on this list is either a
// prototype reachable by URL or was cut; the home page promotes nothing that
// does not work.
const FEATURES = [
  {
    href: "/inventory",
    title: "Find a part",
    body: "Photograph your bench and search it like a document. Ask for a resistor and the resistor lights up — its own pixels, not a box near it.",
    cta: "Search the bench",
  },
  {
    href: "/check",
    title: "Say what you want to build",
    body: "Describe the thing in plain words. Forge works out the parts, checks them against your photo, and tells you exactly what is still missing and where to buy it.",
    cta: "Check what you need",
  },
  {
    href: "/coach",
    title: "Get guided",
    body: "Point the camera at your hands. Forge marks the exact hole to aim for and draws the line from the wire to it, then tells you how to move when you are off.",
    cta: "Start guidance",
  },
  {
    href: "/timeline",
    title: "Keep every working build",
    body: "Each state that works becomes a revision: the wiring, the firmware, the photo. Compare two, see what changed on the board, and roll back.",
    cta: "Open history",
  },
];

export default function HomePage() {
  return (
    <>
      <h1>Forge</h1>
      <p className="muted">
        A camera that understands your workbench: it finds your parts, tells you
        what you still need, guides your hands, and remembers every build that
        worked.
      </p>
      <div className="grid2" style={{ marginTop: "1rem" }}>
        {FEATURES.map((f) => (
          <div className="card" key={f.href}>
            <h2>{f.title}</h2>
            <p className="muted">{f.body}</p>
            <Link href={f.href} className="btn">
              {f.cta}
            </Link>
          </div>
        ))}
      </div>
    </>
  );
}
