// OceanBackground — the three.js sunset ocean that lives behind every route.
//
// Camera pitch is driven by the current route: on `/` the camera looks down
// so the sun is out of frame and the water fills the viewport (a dark,
// dramatic backdrop for the cream Bodoni wordmark). On any inner route it
// eases back to horizon-visible (the demo's "board" mode) so the sky-and-
// water sits above the app chrome.
//
// The three module is dynamically imported so it never blocks first paint.
// The canvas fades in after the shader compiles; a signed-out visitor who
// hits Landing sees the wordmark and buttons instantly, then the ocean
// lights up a beat later.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { useLocation } from "@solidjs/router";
import type * as THREENS from "three";

const isHome = (pathname: string): boolean => pathname === "/" || pathname === "";

export const OceanBackground = () => {
  const [ready, setReady] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const location = useLocation();
  let canvas: HTMLCanvasElement | undefined;
  let disposed = false;
  let stopLoop: (() => void) | null = null;

  onMount(() => {
    if (!canvas) return;

    // Feature detection — WebGL disabled or missing means no shader.
    try {
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
      if (!gl) throw new Error("no gl");
    } catch {
      setFailed(true);
      return;
    }

    // Route-driven camera target. Home mode pitches down so the sun is out
    // of frame (dark water only, cream text stays readable); every other
    // route eases back to horizon-visible for the cinematic sunset.
    const targetFor = (path: string) => (isHome(path) ? -30 : 10);
    let currentTarget = targetFor(location.pathname);
    const smooth = { y: currentTarget };

    (async () => {
      try {
        // Addons ship untyped from `three/examples/jsm/*` — cast to any at the
        // module boundary. The runtime shape is exactly what the reference
        // ocean example uses.
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

        // r183+ pipeline: HalfFloatType output buffer + renderer.setEffects.
        const renderer = new THREE.WebGLRenderer({
          canvas,
          outputBufferType: THREE.HalfFloatType,
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.1;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(55, 1, 1, 20000);
        camera.position.set(30, 30, 100);
        camera.lookAt(0, smooth.y, 0);

        const sun = new THREE.Vector3();

        // Ship the water-normal texture from our own origin — /waternormals.jpg
        // is copied into web/public/ from three's examples set and served
        // by the Worker's assets binding. Hotlinking threejs.org was fine for
        // the demo, but a prod deploy owning its assets is the right shape.
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
        // Cloud uniforms landed in r183; guard so this survives future bumps.
        if (su["cloudCoverage"]) su["cloudCoverage"].value = 0.38;
        if (su["cloudDensity"]) su["cloudDensity"].value = 0.6;
        if (su["cloudElevation"]) su["cloudElevation"].value = 0.69;

        // Sun elevation 8°, azimuth 179.1° — the reference GUI's dead-on
        // horizon sunset. See docs/plans/... (or the demo file) for why.
        const params = { elevation: 8, azimuth: 179.1 };
        const pmrem = new THREE.PMREMGenerator(renderer);
        const sceneEnv = new THREE.Scene();
        let renderTarget: THREENS.WebGLRenderTarget | undefined;
        const updateSun = () => {
          const phi = THREE.MathUtils.degToRad(90 - params.elevation);
          const theta = THREE.MathUtils.degToRad(params.azimuth);
          sun.setFromSphericalCoords(1, phi, theta);
          sky.material.uniforms["sunPosition"].value.copy(sun);
          water.material.uniforms["sunDirection"].value.copy(sun).normalize();
          if (renderTarget) renderTarget.dispose();
          sceneEnv.add(sky);
          renderTarget = pmrem.fromScene(sceneEnv);
          scene.add(sky);
          scene.environment = renderTarget.texture;
        };
        updateSun();

        const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.5, 0.4, 0.85);
        bloomPass.threshold = 0;
        bloomPass.strength = 0.1;
        bloomPass.radius = 0;
        // renderer.setEffects is the r183+ pipeline. Type it loose because
        // the addons's declaration hasn't caught up on some versions.
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
          // Ease camera pitch on route change.
          const want = targetFor(location.pathname);
          if (want !== currentTarget) currentTarget = want;
          smooth.y += (currentTarget - smooth.y) * 0.08;
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
        setReady(true);
      } catch (err) {
        console.error("[ocean] failed to init", err);
        setFailed(true);
      }
    })();
  });

  onCleanup(() => {
    disposed = true;
    if (stopLoop) stopLoop();
  });

  return (
    <Show when={!failed()}>
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: "0",
          "z-index": "-1",
          "pointer-events": "none",
          opacity: ready() ? "1" : "0",
          transition: "opacity 600ms ease",
        }}
      >
        <canvas ref={canvas} style={{ display: "block", width: "100%", height: "100%" }} />
      </div>
    </Show>
  );
};
