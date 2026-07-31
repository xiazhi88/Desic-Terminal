import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const coinModel = "/assets/coins/eth-coin.glb";

export function CoinPreview() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0.16, 6.8);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.82;
    host.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(3.8, 4.4, 4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    scene.add(keyLight);

    const violetLight = new THREE.PointLight(0x8c5cff, 5.8, 8);
    violetLight.position.set(-2.4, 1.2, 2.4);
    scene.add(violetLight);

    const cyanLight = new THREE.PointLight(0x55d7ff, 3.2, 7);
    cyanLight.position.set(2.7, -1.4, 2.2);
    scene.add(cyanLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.95, 96),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.23 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.32;
    floor.position.z = -0.1;
    floor.receiveShadow = true;
    scene.add(floor);

    const glow = new THREE.Mesh(
      new THREE.RingGeometry(1.22, 1.38, 128),
      new THREE.MeshBasicMaterial({
        color: 0x9a6cff,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide,
      })
    );
    glow.position.z = 0.16;

    const loader = new GLTFLoader();
    let coin: THREE.Group | null = null;
    let raf = 0;
    let disposed = false;

    loader.load(coinModel, (gltf) => {
      if (disposed) return;
      coin = gltf.scene;
      coin.rotation.set(-0.08, -0.34, -0.05);
      coin.scale.setScalar(0.92);
      coin.add(glow);
      coin.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      scene.add(coin);
    });

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      camera.position.x = THREE.MathUtils.lerp(camera.position.x, x * 0.55, 0.08);
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0.2 - y * 0.42, 0.08);
    };

    const animate = (time: number) => {
      const t = time / 1000;
      if (coin) {
        coin.rotation.y = -0.34 + Math.sin(t * 0.75) * 0.22;
        coin.rotation.x = -0.08 + Math.sin(t * 1.1) * 0.04;
        coin.position.y = Math.sin(t * 1.4) * 0.08;
        coin.position.z = Math.sin(t * 0.9) * 0.03;
        glow.rotation.z = t * 0.38;
        glow.material.opacity = 0.14 + Math.sin(t * 2.1) * 0.05;
      }
      violetLight.intensity = 5.6 + Math.sin(t * 2.4) * 0.9;
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };

    resize();
    host.addEventListener("pointermove", onPointerMove);
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    raf = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      host.removeEventListener("pointermove", onPointerMove);
      renderer.dispose();
      pmrem.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) {
            material.forEach((item) => item.dispose());
          } else {
            material.dispose();
          }
        }
      });
      host.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <main className="coin-preview" aria-label="ETH 3D coin preview">
      <div className="coin-preview-stage" ref={hostRef} />
    </main>
  );
}
