import * as THREE from '/assets/vendor/three.module.min.js';

export function mountHeroScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 40);
  camera.position.set(0, 0, 11);

  const shardGeometry = new THREE.BufferGeometry();
  shardGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.62, 0, -0.5, -0.4, 0, 0.5, -0.4, 0,
  ], 3));
  shardGeometry.computeVertexNormals();

  const palette = [0xe2001b, 0xf4f0e8, 0x9e0013];
  const count = 46;
  const shards = [];
  const group = new THREE.Group();
  scene.add(group);

  for (let i = 0; i < count; i += 1) {
    const color = palette[i % palette.length];
    const material = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: color === 0xf4f0e8 ? 0.5 : 0.72, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(shardGeometry, material);
    const scale = 0.35 + Math.random() * 0.9;
    mesh.scale.setScalar(scale);
    mesh.position.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 8 - 2);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    group.add(mesh);
    shards.push({
      mesh,
      spin: (Math.random() - 0.5) * 0.006,
      spin2: (Math.random() - 0.5) * 0.004,
      drift: 0.12 + Math.random() * 0.18,
      phase: Math.random() * Math.PI * 2,
    });
  }

  let width = 0;
  let height = 0;
  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);

  let frame = 0;
  let running = true;
  const clock = new THREE.Clock();

  function tick() {
    if (!running) return;
    frame = requestAnimationFrame(tick);
    const elapsed = clock.getElapsedTime();
    for (const shard of shards) {
      shard.mesh.rotation.x += shard.spin;
      shard.mesh.rotation.y += shard.spin2;
      shard.mesh.position.y += Math.sin(elapsed * shard.drift + shard.phase) * 0.0026;
    }
    group.rotation.y = Math.sin(elapsed * 0.05) * 0.12;
    renderer.render(scene, camera);
  }
  tick();

  return function unmount() {
    running = false;
    cancelAnimationFrame(frame);
    observer.disconnect();
    for (const shard of shards) shard.mesh.material.dispose();
    shardGeometry.dispose();
    renderer.dispose();
  };
}
