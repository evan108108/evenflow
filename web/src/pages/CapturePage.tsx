// /capture — internal tool for baking WebGL fallback stills.
//
// Mounts a full-viewport copy of the OceanBackground scene (same textures,
// same sun/sky/water params — must stay in sync with OceanBackground.tsx or
// the still won't match the live shader). Two buttons snap the camera to
// each preset target, let the water animate long enough for a lively frame,
// then read the canvas back as a WebP blob and trigger a download.
//
// Not linked in nav; visited manually at /capture when the stills need to be
// regenerated (shader tweak, sun angle change, etc).

import { onCleanup, onMount, createSignal } from "solid-js";
import type * as THREENS from "three";

const SETTLE_MS = 900;
const STILL_QUALITY = 0.82;

type Preset = { label: string; y: number; filename: string };
const PRESETS: Preset[] = [
  { label: "Home (camera down, no horizon)", y: -30, filename: "ocean-home.webp" },
  { label: "Horizon (inner pages)", y: 10, filename: "ocean-horizon.webp" },
];

export const CapturePage = () => {
  let canvas: HTMLCanvasElement | undefined;
  let disposed = false;
  let cameraRef: THREENS.PerspectiveCamera | undefined;
  let smoothRef: { y: number } | undefined;
  let stopLoop: (() => void) | null = null;

  const [status, setStatus] = createSignal("Booting shader…");
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    if (!canvas) return;

    (async () => {
      try {
        const [THREE, waterMod, skyMod, bloomMod] = await Promise.all([
          import("three") as Promise<typeof THREENS>,
          import("three/examples/jsm/objects/Water.js") as unknown as Promise<{ Water: new (g: unknown, o: unknown) => any }>,
          import("three/examples/jsm/objects/Sky.js") as unknown as Promise<{ Sky: new () => any }>,
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js") as unknown as Promise<{ UnrealBloomPass: new (v: unknown, s: number, r: number, t: number) => any }>,
        ]);
        const { Water } = waterMod;
        const { Sky } = skyMod;
        const { UnrealBloomPass } = bloomMod;
        if (disposed || !canvas) return;

        // preserveDrawingBuffer:true — required so canvas.toBlob reads the
        // most recently rendered pixels. Without it, on many drivers the
        // read comes back empty or with the previous frame.
        const renderer = new THREE.WebGLRenderer({
          canvas,
          outputBufferType: THREE.HalfFloatType,
          preserveDrawingBuffer: true,
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.1;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(55, 1, 1, 20000);
        camera.position.set(30, 30, 100);
        const smooth = { y: PRESETS[0]?.y ?? 0 };
        camera.lookAt(0, smooth.y, 0);
        cameraRef = camera;
        smoothRef = smooth;

        const waterNormals = new THREE.TextureLoader().load(
          "/waternormals.jpg",
          (t: THREENS.Texture) => {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
          },
        );
        const water = new Water(new THREE.PlaneGeometry(10000, 10000), {
          textureWidth: 512,
          textureHeight: 512,
          waterNormals,
          sunDirection: new THREE.Vector3(),
          sunColor: 0xffffff,
          waterColor: 0x001e0f,
          distortionScale: 4.5,
          fog: false,
        });
        water.rotation.x = -Math.PI / 2;
        scene.add(water);
        if (water.material.uniforms["size"]) water.material.uniforms["size"].value = 3.7;

        const sky = new Sky();
        sky.scale.setScalar(10000);
        scene.add(sky);
        const su = sky.material.uniforms;
        su["turbidity"].value = 10;
        su["rayleigh"].value = 2;
        su["mieCoefficient"].value = 0.005;
        su["mieDirectionalG"].value = 0.8;
        if (su["cloudCoverage"]) su["cloudCoverage"].value = 0.38;
        if (su["cloudDensity"]) su["cloudDensity"].value = 0.6;
        if (su["cloudElevation"]) su["cloudElevation"].value = 0.69;

        const params = { elevation: 8, azimuth: 179.1 };
        const sun = new THREE.Vector3();
        const pmrem = new THREE.PMREMGenerator(renderer);
        const sceneEnv = new THREE.Scene();
        let renderTarget: THREENS.WebGLRenderTarget | undefined;
        const phi = THREE.MathUtils.degToRad(90 - params.elevation);
        const theta = THREE.MathUtils.degToRad(params.azimuth);
        sun.setFromSphericalCoords(1, phi, theta);
        sky.material.uniforms["sunPosition"].value.copy(sun);
        water.material.uniforms["sunDirection"].value.copy(sun).normalize();
        sceneEnv.add(sky);
        renderTarget = pmrem.fromScene(sceneEnv);
        scene.add(sky);
        scene.environment = renderTarget.texture;

        const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.5, 0.4, 0.85);
        bloomPass.threshold = 0;
        bloomPass.strength = 0.1;
        bloomPass.radius = 0;
        (renderer as unknown as { setEffects: (p: unknown[]) => void }).setEffects([bloomPass]);

        const resize = () => {
          if (!canvas) return;
          const w = window.innerWidth;
          const h = window.innerHeight;
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        window.addEventListener("resize", resize);
        resize();

        const timer = new THREE.Timer();
        renderer.setAnimationLoop(() => {
          timer.update();
          const time = performance.now() * 0.001;
          water.material.uniforms["time"].value += timer.getDelta();
          if (sky.material.uniforms["time"]) sky.material.uniforms["time"].value = time;
          // Snap-to-target for capture (no easing — we want the still to
          // land on the exact preset, not on whatever frame the ease was
          // partway through).
          camera.lookAt(0, smooth.y, 0);
          renderer.render(scene, camera);
        });

        stopLoop = () => {
          renderer.setAnimationLoop(null);
          window.removeEventListener("resize", resize);
          renderer.dispose();
          if (renderTarget) renderTarget.dispose();
          pmrem.dispose();
        };
        setStatus("Ready. Pick a preset to bake a still.");

        // Automation door: /capture?auto exposes each preset as a data URL
        // on `window.__stills` so an external driver (eyebrowse) can pull
        // them without triggering the file-download branch. Fires once,
        // sequentially, waiting the same SETTLE_MS between camera snap and
        // encode as the manual path.
        (window as any).__captureStill = async (targetY: number): Promise<string> => {
          smooth.y = targetY;
          camera.lookAt(0, targetY, 0);
          await new Promise((r) => setTimeout(r, SETTLE_MS));
          return canvas!.toDataURL("image/webp", STILL_QUALITY);
        };
        if (new URLSearchParams(window.location.search).has("auto")) {
          setStatus("Auto-mode: baking both presets…");
          const stills: Record<string, string> = {};
          for (const p of PRESETS) {
            setStatus(`Auto: ${p.label}…`);
            stills[p.filename] = await (window as any).__captureStill(p.y);
          }
          (window as any).__stills = stills;
          setStatus(`Auto: done. window.__stills has ${Object.keys(stills).length} entries.`);
        }
      } catch (err) {
        console.error("[capture] failed to init", err);
        setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });

  onCleanup(() => {
    disposed = true;
    if (stopLoop) stopLoop();
  });

  const capture = async (preset: Preset) => {
    if (!canvas || !cameraRef || !smoothRef) return;
    setBusy(true);
    setStatus(`Setting camera to ${preset.label}…`);
    smoothRef.y = preset.y;
    cameraRef.lookAt(0, preset.y, 0);
    // Give the water time to animate into a lively frame.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    setStatus("Encoding WebP…");
    const blob: Blob | null = await new Promise((resolve) =>
      canvas!.toBlob((b) => resolve(b), "image/webp", STILL_QUALITY),
    );
    if (!blob) {
      setStatus("Encode failed. Try again.");
      setBusy(false);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = preset.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    const sizeKb = Math.round(blob.size / 1024);
    setStatus(`Downloaded ${preset.filename} (${sizeKb} KB). Drop it into web/public/.`);
    setBusy(false);
  };

  return (
    <>
      <canvas
        ref={canvas}
        style={{
          position: "fixed",
          inset: "0",
          "z-index": "-1",
          "pointer-events": "none",
          display: "block",
          width: "100%",
          height: "100%",
        }}
      />
      <main
        style={{
          "min-height": "100vh",
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          "justify-content": "center",
          gap: "1.2rem",
          padding: "2rem",
          color: "var(--color-cream)",
          "text-shadow": "0 2px 24px rgba(0,0,0,0.6)",
        }}
      >
        <h1 style={{ "font-size": "2rem", margin: 0 }}>Ocean capture</h1>
        <p style={{ margin: 0, "max-width": "42rem", "text-align": "center" }}>
          Downloads a WebP still of the current shader at the requested camera
          preset. Save both files into <code>web/public/</code> so the WebGL
          fallback can serve them.
        </p>
        <div style={{ display: "flex", gap: "0.8rem", "flex-wrap": "wrap", "justify-content": "center" }}>
          {PRESETS.map((preset) => (
            <button
              class="btn-over-ocean"
              disabled={busy()}
              onClick={() => void capture(preset)}
              style={{ padding: "0.9rem 1.4rem", "font-size": "1rem" }}
            >
              Download {preset.filename}
            </button>
          ))}
        </div>
        <p style={{ margin: 0, opacity: 0.85, "font-size": "0.9rem" }}>{status()}</p>
      </main>
    </>
  );
};
