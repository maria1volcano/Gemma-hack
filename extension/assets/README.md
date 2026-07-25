# `extension/assets/` — where the mascot model goes

## Drop the model here

```text
extension/assets/mascot.glb
```

Exactly that path and that name. It is loaded with
`chrome.runtime.getURL('assets/mascot.glb')` (the folder is already declared in
`web_accessible_resources`), and in the preview harness it resolves to the
relative path `assets/mascot.glb`.

Nothing else is required: if the file is present it becomes the character on the
next page load, if it is absent the procedural capybara in
`../mascot/mascot-fallback.js` is used. No console error either way — the file
is probed with `fetch` before `GLTFLoader` is invoked.

**No GLB is shipped in this repo.** Nothing was downloaded from the internet
(unclear licensing) and nothing was generated: what you see on screen today is
the procedural capybara.

## What the loader expects

| Property | Assumption | What happens if you differ |
|---|---|---|
| Format | binary glTF 2.0 (`.glb`, embedded textures) | `.gltf` + external files will not resolve; embed them |
| Up axis | **+Y up** (standard glTF) | a Z-up export will lie on its side — re-export from Blender with the default glTF settings |
| Forward axis | **+Z toward the camera** (the model faces the viewer) | if the bounding box is more than 1.6× longer on X than on Z the loader assumes a +X-facing export and rotates it −90° on Y automatically |
| Scale | any — **auto-scaled** | the model is measured and scaled to fill ~78 % of the 150×190 px canvas |
| Origin | any — **auto-centred** | the bounding-box centre is moved to the camera target |
| Poly budget | keep under ~40 k triangles | it runs on every demo page next to a live agent |
| Textures | ≤ 1024², embedded | bigger textures just cost memory |
| Materials | PBR metal/rough | rendered with `outputEncoding = sRGBEncoding` (three r137) |

The whole model is then framed with a rotation-safe fit (horizontal extent =
`max(sizeX, sizeZ)`), so it can turn while pointing without ever poking outside
the canvas.

## Animation clips (optional)

Name them loosely; matching is case-insensitive substring matching:

| Mood | Names that match |
|---|---|
| `idle` | `idle`, `breath`, `breathing`, `stand`, `standing`, `rest`, `loop` |
| `happy` | `happy`, `wave`, `celebrate`, `jump`, `cheer`, `yes`, `dance` |
| `worry` | `worry`, `worried`, `fear`, `afraid`, `concern`, `no`, `sad`, `scare` |
| `point` | `point`, `gesture`, `look`, `aim`, `show` |

Clips crossfade over 280 ms and a clip that is already playing is never
restarted. Any mood without a clip keeps the procedural motion (bob, lean,
turn), so a GLB with only an idle loop still reads correctly.

## Style target

Match the reference: a chunky, kid-friendly capybara figurine — cream / warm
off-white body, dark warm brown blunt muzzle, brown rounded ears and brown
stubby hooves, big glossy black eyes, very stocky proportions, soft matte
materials. It must read at ~150 px on screen: no fine detail, no accessories.
