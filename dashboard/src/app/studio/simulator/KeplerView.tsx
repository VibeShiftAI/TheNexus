"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type SpaceObject } from "@/lib/studio";
import { massEarth, radiusEarth } from "@/lib/nbody";

// Real planet surface maps (threex.planets), CORS-enabled via jsDelivr.
const TEX = "https://cdn.jsdelivr.net/gh/jeromeetienne/threex.planets@master/images";
const PLANET_TEX: Record<string, string> = {
  sun: `${TEX}/sunmap.jpg`, mercury: `${TEX}/mercurymap.jpg`, venus: `${TEX}/venusmap.jpg`,
  earth: `${TEX}/earthmap1k.jpg`, mars: `${TEX}/marsmap1k.jpg`, jupiter: `${TEX}/jupitermap.jpg`,
  saturn: `${TEX}/saturnmap.jpg`, uranus: `${TEX}/uranusmap.jpg`, neptune: `${TEX}/neptunemap.jpg`,
};
const SCENE_RADIUS = 16;

function specNum(o: SpaceObject, key: string): number | null {
  const s = (o.spec_values || []).find((x) => x.spec_key === key);
  if (!s || s.status === "unknown" || s.status === "not_applicable") return null;
  if (typeof s.value_number === "number") return s.value_number;
  const n = s.value_text != null ? parseFloat(s.value_text) : NaN;
  return Number.isFinite(n) ? n : null;
}
function textureFor(o: SpaceObject): string {
  const key = o.name.trim().toLowerCase();
  if (PLANET_TEX[key]) return PLANET_TEX[key];
  const kind = o.object_kind || "";
  if (/gas giant|jovian/i.test(kind)) return PLANET_TEX.jupiter;
  if (/ice giant/i.test(kind)) return PLANET_TEX.neptune;
  if (/star|dwarf/i.test(kind)) return PLANET_TEX.sun;
  return PLANET_TEX.mercury;
}

function solveKepler(M: number, e: number): number {
  let E = M;
  for (let i = 0; i < 6; i += 1) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

function labelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 30px sans-serif";
  ctx.fillStyle = "rgba(15,23,42,0.7)";
  const w = ctx.measureText(text).width + 20;
  ctx.fillRect((256 - w) / 2, 10, w, 44);
  ctx.fillStyle = "#e2e8f0";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(canvas);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.scale.set(2.4, 0.6, 1);
  return spr;
}

interface Planet { mesh: THREE.Mesh; label: THREE.Sprite; a: number; e: number; n: number; phase: number; }

export default function KeplerView({ objects, playing, speed }: { objects: SpaceObject[]; playing: boolean; speed: number }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  useEffect(() => {
    if (!objects.length || !mountRef.current) return;
    const mount = mountRef.current;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04060d);
    const camera = new THREE.PerspectiveCamera(55, mount.clientWidth / mount.clientHeight, 0.01, 100000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Milky Way skybox sphere (verified-200 jpg; falls back to star points on failure).
    const skyboxMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, color: 0x0a0e1a });
    loader.load("https://cdn.jsdelivr.net/npm/spacekit.js@0.1.1/src/assets/skybox/nasa_tycho.jpg",
      (t) => { t.colorSpace = THREE.SRGBColorSpace; skyboxMat.map = t; skyboxMat.color.set(0xffffff); skyboxMat.needsUpdate = true; }, undefined, () => {
        const g = new THREE.BufferGeometry();
        const p = new Float32Array(1500 * 3);
        for (let i = 0; i < p.length; i += 1) p[i] = (Math.random() - 0.5) * 800;
        g.setAttribute("position", new THREE.BufferAttribute(p, 3));
        scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x6677aa, size: 0.7 })));
      });
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyboxMat));

    // Lighting: point light at the star + soft ambient (real day/night terminators).
    scene.add(new THREE.PointLight(0xfff2e0, 2.6, 0, 0.0));
    scene.add(new THREE.AmbientLight(0x404048, 1.0));

    // ----- bodies -----
    const masses = objects.map(massEarth);
    const centralIdx = masses.indexOf(Math.max(...masses));
    const orbiters = objects.filter((_, i) => i !== centralIdx);
    const semiMajors = orbiters.map((o) => specNum(o, "orbital.semi_major_axis_au") ?? 1);
    const maxA = Math.max(0.5, ...semiMajors);
    const minA = Math.min(...semiMajors.filter((x) => x > 0), maxA);
    const toScene = SCENE_RADIUS / maxA;
    // Base mean-motion so the innermost orbit takes ~16s at 1x.
    const baseN = (2 * Math.PI) / (16 * 60) * Math.pow(minA, 1.5);

    // Central star (bright textured sphere, not lit so it never goes dark).
    const starR = Math.max(0.7, SCENE_RADIUS * 0.06);
    const starMesh = new THREE.Mesh(
      new THREE.SphereGeometry(starR, 48, 32),
      new THREE.MeshBasicMaterial({ map: loadTex(loader, textureFor(objects[centralIdx])), color: 0xffffff })
    );
    scene.add(starMesh);
    const starLabel = labelSprite(objects[centralIdx].name);
    starLabel.position.set(0, starR + 0.6, 0);
    scene.add(starLabel);

    const planets: Planet[] = [];
    orbiters.forEach((o, i) => {
      const a = (semiMajors[i] || 1.2 + i) * toScene;
      const e = Math.min(0.6, specNum(o, "orbital.eccentricity") ?? 0);
      const rE = radiusEarth(o);
      const r = Math.min(SCENE_RADIUS * 0.06, Math.max(SCENE_RADIUS * 0.02, SCENE_RADIUS * (0.018 + 0.02 * Math.log10(1 + rE))));
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 40, 28),
        new THREE.MeshStandardMaterial({ map: loadTex(loader, textureFor(o)), roughness: 0.9, metalness: 0.0 })
      );
      scene.add(mesh);

      // Orbit ellipse.
      const curve = new THREE.EllipseCurve(-a * e, 0, a, a * Math.sqrt(1 - e * e), 0, 2 * Math.PI, false, 0);
      const pts = curve.getPoints(128).map((p) => new THREE.Vector3(p.x, 0, p.y));
      const orbit = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x3b4a6b, transparent: true, opacity: 0.7 })
      );
      scene.add(orbit);

      const label = labelSprite(o.name);
      scene.add(label);
      planets.push({ mesh, label, a, e, n: baseN * Math.pow(Math.max(semiMajors[i] || 1, 0.05), -1.5), phase: (i * 2.2) % (2 * Math.PI) });
    });

    camera.position.set(SCENE_RADIUS * 1.5, SCENE_RADIUS * 1.05, SCENE_RADIUS * 1.5);
    controls.target.set(0, 0, 0);
    controls.update();

    let raf = 0;
    let t = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      if (playingRef.current) t += speedRef.current;
      for (const p of planets) {
        const M = p.phase + p.n * t;
        const E = solveKepler(M, p.e);
        const x = p.a * (Math.cos(E) - p.e);
        const z = p.a * Math.sqrt(1 - p.e * p.e) * Math.sin(E);
        p.mesh.position.set(x, 0, z);
        p.mesh.rotation.y += 0.01 * speedRef.current;
        p.label.position.set(x, z === 0 ? 0 : 0, z);
        p.label.position.y = (p.mesh.geometry as THREE.SphereGeometry).parameters.radius + 0.5;
        p.label.position.x = x;
        p.label.position.z = z;
      }
      starMesh.rotation.y += 0.002 * speedRef.current;
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [objects]);

  return <div ref={mountRef} className="h-full w-full" />;
}

function loadTex(loader: THREE.TextureLoader, url: string): THREE.Texture {
  const t = loader.load(url, undefined, undefined, () => {});
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
