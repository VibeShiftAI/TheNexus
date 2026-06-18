"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type SpaceObject } from "@/lib/studio";
import { computeInitialConditions, referenceTimeStep, step, type Body } from "@/lib/nbody";

const TRAIL_LEN = 300;
const SUBSTEPS = 16; // more, smaller integration steps per frame → smooth, stable motion
const TARGET_ORBIT_SECONDS = 22; // slower default cadence reads as smoother (speed slider goes up to 5×)
const SCENE_RADIUS = 18; // render space is normalized to this regardless of the system's real size

// Body render size in *scene units* (decoupled from physics distances) so a planet
// is never a sub-pixel speck — the bug where "only a star appeared".
function bodyRadiusScene(radiusEarth: number, isStar: boolean): number {
  if (isStar) return SCENE_RADIUS * 0.05; // ~0.9 units
  const s = 0.35 + 0.35 * Math.log10(1 + Math.max(0.1, radiusEarth));
  return Math.min(SCENE_RADIUS * 0.06, Math.max(SCENE_RADIUS * 0.02, s)); // clamped, always visible
}

export default function NbodyView({ objects, playing, speed }: { objects: SpaceObject[]; playing: boolean; speed: number }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  const bodiesRef = useRef<Body[]>([]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  useEffect(() => {
    if (!objects.length || !mountRef.current) return;
    const mount = mountRef.current;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070f);
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(1500 * 3);
    for (let i = 0; i < starPos.length; i += 1) starPos[i] = (Math.random() - 0.5) * 600;
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x6677aa, size: 0.6 })));
    scene.add(new THREE.AmbientLight(0x223044, 1.2));

    const meshes: THREE.Mesh[] = [];
    const trails: Array<{ line: THREE.Line; positions: Float32Array; count: number }> = [];
    let pointLight: THREE.PointLight | null = null;
    let renderScale = 1;

    function buildBodies() {
      meshes.forEach((m) => { scene.remove(m); m.geometry.dispose(); });
      trails.forEach((t) => { scene.remove(t.line); t.line.geometry.dispose(); });
      meshes.length = 0;
      trails.length = 0;

      const bodies = computeInitialConditions(objects);
      bodiesRef.current = bodies;

      // Normalize render space so the whole system fits, regardless of real AU span.
      const maxR = Math.max(1e-6, ...bodies.map((b) => Math.hypot(b.pos[0], b.pos[1], b.pos[2])));
      renderScale = SCENE_RADIUS / maxR;

      bodies.forEach((b) => {
        const r = bodyRadiusScene(b.radius, b.isStar);
        const geo = new THREE.SphereGeometry(r, 32, 24);
        const mat = b.isStar
          ? new THREE.MeshBasicMaterial({ color: b.color })
          : new THREE.MeshStandardMaterial({ color: b.color, emissive: new THREE.Color(b.color).multiplyScalar(0.2), roughness: 0.8 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(b.pos[0] * renderScale, b.pos[1] * renderScale, b.pos[2] * renderScale);
        scene.add(mesh);
        meshes.push(mesh);
        if (b.isStar && !pointLight) { pointLight = new THREE.PointLight(0xfff2d0, 2.6, 0, 0.25); mesh.add(pointLight); }

        const positions = new Float32Array(TRAIL_LEN * 3);
        const tgeo = new THREE.BufferGeometry();
        tgeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        tgeo.setDrawRange(0, 0);
        const line = new THREE.Line(tgeo, new THREE.LineBasicMaterial({ color: b.color, transparent: true, opacity: 0.5 }));
        scene.add(line);
        trails.push({ line, positions, count: 0 });
      });

      camera.position.set(SCENE_RADIUS * 1.6, SCENE_RADIUS * 1.1, SCENE_RADIUS * 1.6);
      controls.target.set(0, 0, 0);
      controls.update();
    }

    let dt = 0.02;
    buildBodies();
    dt = referenceTimeStep(bodiesRef.current, TARGET_ORBIT_SECONDS);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      if (playingRef.current) {
        for (let s = 0; s < SUBSTEPS; s += 1) step(bodiesRef.current, (dt * speedRef.current) / SUBSTEPS);
        bodiesRef.current.forEach((b, i) => {
          meshes[i].position.set(b.pos[0] * renderScale, b.pos[1] * renderScale, b.pos[2] * renderScale);
          const t = trails[i];
          if (t.count < TRAIL_LEN) t.count += 1; else t.positions.copyWithin(0, 3);
          const idx = (t.count - 1) * 3;
          t.positions[idx] = b.pos[0] * renderScale;
          t.positions[idx + 1] = b.pos[1] * renderScale;
          t.positions[idx + 2] = b.pos[2] * renderScale;
          t.line.geometry.setDrawRange(0, t.count);
          (t.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        });
      }
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [objects]);

  return <div ref={mountRef} className="h-full w-full" />;
}
