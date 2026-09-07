# Gates: Forge showcase redesign

OWNS: showcase/**

Scope: Redesign the static GitHub Pages showcase as a premium, cinematic product presentation for Forge.

- [ ] G1: The showcase contains the product story, all four capability surfaces, project links, and the existing media assets.
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('showcase/index.html','utf8'); const u=s.toUpperCase(); for(const x of ['RECOGNIZE','CONNECT','TEST','COMMIT','INVENTORY','ASSEMBLY','FIRMWARE','TIMELINE','HARDWARE_SDLC','APP-INVENTORY.PNG','APP-ASSEMBLE.PNG','APP-TIMELINE.PNG','WIRING-CUT.MP4']) if(!u.includes(x)) throw Error('missing '+x); console.log('showcase content passed')"
  EXPECT: showcase content passed
  EVIDENCE: pending

- [ ] G2: The showcase stylesheet includes responsive layout, reduced-motion support, and the cinematic visual system.
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('showcase/styles.css','utf8'); for(const x of ['@media(max-width:760px)','prefers-reduced-motion','--acid','background:var(--night)','.hero-visual','.capability-grid']) if(!s.includes(x)) throw Error('missing '+x); console.log('showcase styles passed')"
  EXPECT: showcase styles passed
  EVIDENCE: pending

- [ ] G3: The page looks coherent at desktop and mobile widths, with readable contrast, functioning links, and motion that does not block access.
  EVIDENCE: pending
