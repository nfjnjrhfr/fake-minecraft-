/* Fake Minecraft - a small voxel sandbox on raw WebGL. No dependencies. */
'use strict';

/* ------------------------------------------------------------------ *
 * Math (column-major 4x4, the layout WebGL wants)
 * ------------------------------------------------------------------ */
function mat4() { return new Float32Array(16); }

function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect; out[5] = f; out[11] = -1;
  out[10] = (far + near) * nf; out[14] = 2 * far * near * nf;
  return out;
}

function lookAt(out, eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = 1 / Math.hypot(zx, zy, zz); zx *= l; zy *= l; zz *= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz); l = l ? 1 / l : 0; xx *= l; xy *= l; xz *= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

function multiply(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */
const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, SAND = 4, LOG = 5,
      LEAVES = 6, PLANKS = 7, COBBLE = 8, WATER = 9, GLASS = 10, BEDROCK = 11;

// Atlas tile ids, laid out in a 4x4 grid.
const T = {
  grassTop: 0, dirt: 1, grassSide: 2, stone: 3,
  sand: 4, logSide: 5, logTop: 6, leaves: 7,
  planks: 8, cobble: 9, water: 10, glass: 11,
  bedrock: 12
};

// tiles: [top, bottom, side]
const BLOCKS = {
  [GRASS]:   { name: 'Grass Block', tiles: [T.grassTop, T.dirt, T.grassSide] },
  [DIRT]:    { name: 'Dirt',        tiles: [T.dirt, T.dirt, T.dirt] },
  [STONE]:   { name: 'Stone',       tiles: [T.stone, T.stone, T.stone] },
  [SAND]:    { name: 'Sand',        tiles: [T.sand, T.sand, T.sand] },
  [LOG]:     { name: 'Oak Log',     tiles: [T.logTop, T.logTop, T.logSide] },
  [LEAVES]:  { name: 'Leaves',      tiles: [T.leaves, T.leaves, T.leaves] },
  [PLANKS]:  { name: 'Oak Planks',  tiles: [T.planks, T.planks, T.planks] },
  [COBBLE]:  { name: 'Cobblestone', tiles: [T.cobble, T.cobble, T.cobble] },
  [WATER]:   { name: 'Water',       tiles: [T.water, T.water, T.water], liquid: true, transparent: true },
  [GLASS]:   { name: 'Glass',       tiles: [T.glass, T.glass, T.glass], transparent: true },
  [BEDROCK]: { name: 'Bedrock',     tiles: [T.bedrock, T.bedrock, T.bedrock], unbreakable: true }
};

const isTransparent = b => b === AIR || !!(BLOCKS[b] && BLOCKS[b].transparent);
const isSolid       = b => b !== AIR && !(BLOCKS[b] && BLOCKS[b].liquid);
// Leaves and glass let light through, so they do not cast ambient occlusion.
const occludes      = b => isSolid(b) && b !== LEAVES && b !== GLASS;

const HOTBAR = [GRASS, DIRT, STONE, COBBLE, SAND, PLANKS, LOG, LEAVES, GLASS];

/* ------------------------------------------------------------------ *
 * Texture atlas, painted pixel by pixel at startup
 * ------------------------------------------------------------------ */
const TILE = 16, ATLAS_TILES = 4, ATLAS_PX = TILE * ATLAS_TILES;

function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = ATLAS_PX;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(ATLAS_PX, ATLAS_PX);
  const px = img.data;
  let seed = 1337;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

  const put = (tile, x, y, r, g, b, a) => {
    const gx = (tile % ATLAS_TILES) * TILE + x, gy = ((tile / ATLAS_TILES) | 0) * TILE + y;
    const i = (gy * ATLAS_PX + gx) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a === undefined ? 255 : a;
  };
  // Flat colour plus per-pixel grain.
  const noisy = (tile, r, g, b, amt, alpha) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const n = (rnd() - 0.5) * 2 * amt;
      put(tile, x, y, r + n, g + n, b + n, alpha);
    }
  };

  noisy(T.grassTop, 106, 170, 78, 22);
  noisy(T.dirt, 134, 96, 67, 20);
  noisy(T.stone, 130, 130, 130, 18);
  noisy(T.sand, 219, 207, 160, 16);
  noisy(T.planks, 162, 130, 78, 14);
  noisy(T.cobble, 122, 122, 122, 30);
  noisy(T.bedrock, 70, 70, 74, 34);
  noisy(T.leaves, 66, 132, 52, 30);
  noisy(T.logSide, 106, 84, 52, 16);
  noisy(T.logTop, 150, 122, 78, 14);
  noisy(T.water, 54, 96, 200, 14, 178);

  // Grass side: a green lip with a ragged edge over dirt.
  for (let x = 0; x < TILE; x++) {
    const lip = 3 + ((rnd() * 3) | 0);
    for (let y = 0; y < TILE; y++) {
      const n = (rnd() - 0.5) * 40;
      if (y < lip) put(T.grassSide, x, y, 106 + n * 0.5, 170 + n * 0.5, 78 + n * 0.5);
      else put(T.grassSide, x, y, 134 + n * 0.4, 96 + n * 0.4, 67 + n * 0.4);
    }
  }
  // Cobble: scatter darker mortar lines.
  for (let i = 0; i < 46; i++) {
    const x = (rnd() * TILE) | 0, y = (rnd() * TILE) | 0;
    put(T.cobble, x, y, 88, 88, 88);
  }
  // Log top: concentric rings.
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    if ((d | 0) % 3 === 0) put(T.logTop, x, y, 120, 96, 60);
  }
  // Leaves: punch a few holes so you can see through the canopy.
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    if (rnd() < 0.07) put(T.leaves, x, y, 0, 0, 0, 0);
  }
  // Glass: transparent middle, pale frame.
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const edge = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
    put(T.glass, x, y, 210, 232, 240, edge ? 210 : 26);
  }

  ctx.putImageData(img, 0, 0);
  return cv;
}

/* ------------------------------------------------------------------ *
 * World storage
 * ------------------------------------------------------------------ */
const CS = 16;                       // chunk edge, in blocks
const CHUNKS_X = 12, CHUNKS_Z = 12;  // world is 192 x 192 blocks
const WX = CHUNKS_X * CS, WZ = CHUNKS_Z * CS, WY = 64;
const SEA = 30;

const blocks = new Uint8Array(WX * WY * WZ);
const at = (x, y, z) => (y * WZ + z) * WX + x;

function getBlock(x, y, z) {
  if (y < 0) return BEDROCK;                       // world floor, so nothing falls out
  if (y >= WY || x < 0 || x >= WX || z < 0 || z >= WZ) return AIR;
  return blocks[at(x, y, z)];
}
function setBlockRaw(x, y, z, b) {
  if (x < 0 || x >= WX || y < 0 || y >= WY || z < 0 || z >= WZ) return;
  blocks[at(x, y, z)] = b;
}

/* ------------------------------------------------------------------ *
 * Terrain generation - value noise, fbm, a few caves, a few trees
 * ------------------------------------------------------------------ */
let SEED = (Math.random() * 1e9) | 0;

function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483629) ^ SEED;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

function noise2(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const tx = smooth(x - xi), tz = smooth(z - zi);
  return lerp(
    lerp(hash3(xi, 0, zi), hash3(xi + 1, 0, zi), tx),
    lerp(hash3(xi, 0, zi + 1), hash3(xi + 1, 0, zi + 1), tx), tz);
}
function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const tx = smooth(x - xi), ty = smooth(y - yi), tz = smooth(z - zi);
  const c = (dy) => lerp(
    lerp(hash3(xi, yi + dy, zi), hash3(xi + 1, yi + dy, zi), tx),
    lerp(hash3(xi, yi + dy, zi + 1), hash3(xi + 1, yi + dy, zi + 1), tx), tz);
  return lerp(c(0), c(1), ty);
}
function fbm2(x, z, octaves) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * freq, z * freq) * amp;
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}

function heightAt(x, z) {
  const base = fbm2(x / 48, z / 48, 4);            // rolling hills
  const ridge = Math.pow(noise2(x / 74, z / 74), 3); // where mountains are allowed
  return Math.floor(15 + base * 26 + ridge * 30);
}

function generateWorld() {
  const heights = new Int32Array(WX * WZ);
  for (let z = 0; z < WZ; z++)
    for (let x = 0; x < WX; x++) heights[z * WX + x] = heightAt(x, z);

  // Noise drifts from seed to seed, so re-centre the map on sea level. Without
  // this some worlds come out as one big ocean and others as one big plateau.
  const sorted = Int32Array.from(heights).sort();
  const median = sorted[sorted.length >> 1];
  const shift = Math.max(-14, Math.min(14, SEA + 4 - median));

  for (let z = 0; z < WZ; z++) {
    for (let x = 0; x < WX; x++) {
      const h = Math.max(2, Math.min(WY - 12, heights[z * WX + x] + shift));
      heights[z * WX + x] = h;
      const beach = h <= SEA + 1;

      for (let y = 0; y <= h; y++) {
        let b;
        if (y === 0) b = BEDROCK;
        else if (y < h - 3) b = STONE;
        else if (y < h) b = beach ? SAND : DIRT;
        else b = beach ? SAND : GRASS;
        blocks[at(x, y, z)] = b;
      }
      for (let y = h + 1; y <= SEA; y++) blocks[at(x, y, z)] = WATER;
    }
  }

  // Caves: carve where a low-frequency 3D field crosses a threshold.
  for (let y = 2; y < 42; y++) {
    for (let z = 0; z < WZ; z++) {
      for (let x = 0; x < WX; x++) {
        const i = at(x, y, z);
        if (blocks[i] !== STONE) continue;
        const n = noise3(x / 22, y / 14, z / 22) * 0.65 + noise3(x / 9, y / 7, z / 9) * 0.35;
        if (n > 0.63) blocks[i] = AIR;
      }
    }
  }

  // Trees on dry grass, with a little breathing room between trunks.
  const planted = [];
  for (let z = 3; z < WZ - 3; z++) {
    for (let x = 3; x < WX - 3; x++) {
      const h = heights[z * WX + x];
      if (blocks[at(x, h, z)] !== GRASS) continue;
      if (hash3(x, 91, z) > 0.008) continue;
      if (planted.some(p => Math.abs(p[0] - x) < 6 && Math.abs(p[1] - z) < 6)) continue;
      planted.push([x, z]);

      const trunk = 4 + ((hash3(x, 92, z) * 3) | 0);
      const top = h + trunk;
      if (top + 2 >= WY) continue;
      for (let y = h + 1; y <= top; y++) setBlockRaw(x, y, z, LOG);
      for (let dy = -2; dy <= 1; dy++) {
        const r = dy <= -1 ? 2 : 1;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (dy === 1 && Math.abs(dx) + Math.abs(dz) > 1) continue;
          if (Math.abs(dx) === r && Math.abs(dz) === r && hash3(x + dx, dy, z + dz) < 0.5) continue;
          if (dx === 0 && dz === 0 && dy <= 0) continue;
          if (getBlock(x + dx, top + dy, z + dz) === AIR) setBlockRaw(x + dx, top + dy, z + dz, LEAVES);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Meshing
 * ------------------------------------------------------------------ */
// Per face: normal, quad origin, the two in-plane axes, which tile to use
// (0 top / 1 bottom / 2 side), a fixed shade, and whether v runs with the axis.
const FACES = [
  { n: [ 1, 0, 0], o: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], t: 2, s: 0.72, vUp: true },
  { n: [-1, 0, 0], o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0], t: 2, s: 0.72, vUp: true },
  { n: [0,  1, 0], o: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], t: 0, s: 1.00, vUp: false },
  { n: [0, -1, 0], o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], t: 1, s: 0.48, vUp: false },
  { n: [0, 0,  1], o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], t: 2, s: 0.86, vUp: true },
  { n: [0, 0, -1], o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], t: 2, s: 0.86, vUp: true }
];

const UV_PAD = 0.5 / ATLAS_PX;
function tileUV(tile, a, b) {
  const tx = tile % ATLAS_TILES, ty = (tile / ATLAS_TILES) | 0;
  const s = 1 / ATLAS_TILES;
  return [(tx + a) * s + (a ? -UV_PAD : UV_PAD), (ty + b) * s + (b ? -UV_PAD : UV_PAD)];
}

// Should this face exist? Yes when the neighbour lets light through, except
// that water never draws faces against more water.
function faceVisible(here, there) {
  if (!isTransparent(there)) return false;
  if (here === there) return false;
  if (here === WATER && there === AIR) return true;
  return true;
}

function ambient(bx, by, bz, f, a, b) {
  const du = a ? 1 : -1, dv = b ? 1 : -1;
  const px = bx + f.n[0], py = by + f.n[1], pz = bz + f.n[2];
  const s1 = occludes(getBlock(px + du * f.u[0], py + du * f.u[1], pz + du * f.u[2]));
  const s2 = occludes(getBlock(px + dv * f.v[0], py + dv * f.v[1], pz + dv * f.v[2]));
  if (s1 && s2) return 0;
  const c = occludes(getBlock(
    px + du * f.u[0] + dv * f.v[0],
    py + du * f.u[1] + dv * f.v[1],
    pz + du * f.u[2] + dv * f.v[2]));
  return 3 - (s1 ? 1 : 0) - (s2 ? 1 : 0) - (c ? 1 : 0);
}

function meshChunk(cx, cz) {
  const opaque = { verts: [], idx: [] }, alpha = { verts: [], idx: [] };
  const x0 = cx * CS, z0 = cz * CS;

  for (let y = 0; y < WY; y++) {
    for (let z = z0; z < z0 + CS; z++) {
      for (let x = x0; x < x0 + CS; x++) {
        const b = blocks[at(x, y, z)];
        if (b === AIR) continue;
        const def = BLOCKS[b];
        const target = def.transparent ? alpha : opaque;

        for (const f of FACES) {
          if (!faceVisible(b, getBlock(x + f.n[0], y + f.n[1], z + f.n[2]))) continue;

          const tile = def.tiles[f.t];
          const base = target.verts.length / 6;
          const ao = [ambient(x, y, z, f, 0, 0), ambient(x, y, z, f, 1, 0),
                      ambient(x, y, z, f, 1, 1), ambient(x, y, z, f, 0, 1)];
          const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];

          for (let i = 0; i < 4; i++) {
            const [a, bb] = corners[i];
            const uv = tileUV(tile, a, f.vUp ? 1 - bb : bb);
            target.verts.push(
              x + f.o[0] + a * f.u[0] + bb * f.v[0],
              y + f.o[1] + a * f.u[1] + bb * f.v[1],
              z + f.o[2] + a * f.u[2] + bb * f.v[2],
              uv[0], uv[1],
              f.s * (0.55 + 0.15 * ao[i]));
          }
          // Split the quad along the darker diagonal so ambient occlusion
          // does not bend across the seam.
          if (ao[0] + ao[2] < ao[1] + ao[3]) {
            target.idx.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
          } else {
            target.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
      }
    }
  }
  return { opaque, alpha };
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */
const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { antialias: false }) ||
           canvas.getContext('webgl', { antialias: false });
if (!gl) {
  document.getElementById('loading').textContent = 'This browser has no WebGL.';
  throw new Error('no webgl');
}
const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
if (!isGL2 && !gl.getExtension('OES_element_index_uint')) {
  document.getElementById('loading').textContent = 'Missing OES_element_index_uint.';
  throw new Error('no uint indices');
}

const SKY = [0.47, 0.66, 1.0];
const FOG_AIR = [46, 130], FOG_WATER = [1, 20];

function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
function program(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

const chunkProg = program(`
  attribute vec3 aPos;
  attribute vec2 aUV;
  attribute float aLight;
  uniform mat4 uMVP;
  uniform vec3 uEye;
  uniform vec2 uFogRange;
  varying vec2 vUV;
  varying float vLight;
  varying float vFog;
  void main() {
    gl_Position = uMVP * vec4(aPos, 1.0);
    vUV = aUV;
    vLight = aLight;
    vFog = clamp((distance(aPos, uEye) - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0);
  }`, `
  precision mediump float;
  uniform sampler2D uTex;
  uniform vec3 uFog;
  varying vec2 vUV;
  varying float vLight;
  varying float vFog;
  void main() {
    vec4 c = texture2D(uTex, vUV);
    if (c.a < 0.02) discard;
    vec3 lit = mix(c.rgb * vLight, uFog, vFog);
    gl_FragColor = vec4(lit, c.a);
  }`);

const lineProg = program(`
  attribute vec3 aPos;
  uniform mat4 uMVP;
  void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`, `
  precision mediump float;
  uniform vec4 uColor;
  void main() { gl_FragColor = uColor; }`);

const A = {
  pos: gl.getAttribLocation(chunkProg, 'aPos'),
  uv: gl.getAttribLocation(chunkProg, 'aUV'),
  light: gl.getAttribLocation(chunkProg, 'aLight')
};
const U = {
  mvp: gl.getUniformLocation(chunkProg, 'uMVP'),
  eye: gl.getUniformLocation(chunkProg, 'uEye'),
  tex: gl.getUniformLocation(chunkProg, 'uTex'),
  fog: gl.getUniformLocation(chunkProg, 'uFog'),
  fogRange: gl.getUniformLocation(chunkProg, 'uFogRange')
};
const LU = {
  pos: gl.getAttribLocation(lineProg, 'aPos'),
  mvp: gl.getUniformLocation(lineProg, 'uMVP'),
  color: gl.getUniformLocation(lineProg, 'uColor')
};

const atlasCanvas = buildAtlas();
const texture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

/* One pair of buffers per chunk: solid geometry, and see-through geometry. */
const chunks = [];
for (let cz = 0; cz < CHUNKS_Z; cz++) {
  for (let cx = 0; cx < CHUNKS_X; cx++) {
    chunks.push({
      cx, cz, dirty: true,
      opaque: { vbo: gl.createBuffer(), ibo: gl.createBuffer(), count: 0 },
      alpha:  { vbo: gl.createBuffer(), ibo: gl.createBuffer(), count: 0 }
    });
  }
}
const chunkAt = (cx, cz) => chunks[cz * CHUNKS_X + cx];

function upload(part, data) {
  part.count = data.idx.length;
  if (!part.count) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, part.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data.verts), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(data.idx), gl.STATIC_DRAW);
}

function rebuild(chunk) {
  const m = meshChunk(chunk.cx, chunk.cz);
  upload(chunk.opaque, m.opaque);
  upload(chunk.alpha, m.alpha);
  chunk.dirty = false;
}

function markDirty(x, y, z) {
  const cx = Math.floor(x / CS), cz = Math.floor(z / CS);
  const lx = x - cx * CS, lz = z - cz * CS;
  // The chunk itself, plus any neighbour whose border faces this block.
  const xs = [0], zs = [0];
  if (lx === 0) xs.push(-1);
  if (lx === CS - 1) xs.push(1);
  if (lz === 0) zs.push(-1);
  if (lz === CS - 1) zs.push(1);
  for (const dz of zs) for (const dx of xs) {
    const nx = cx + dx, nz = cz + dz;
    if (nx >= 0 && nz >= 0 && nx < CHUNKS_X && nz < CHUNKS_Z) chunkAt(nx, nz).dirty = true;
  }
}

// Cheap horizontal cull: drop chunks that sit well behind the camera.
function chunkVisible(c, eye, dir) {
  const dx = c.cx * CS + CS / 2 - eye[0], dz = c.cz * CS + CS / 2 - eye[2];
  const dist = Math.hypot(dx, dz);
  if (dist < 24) return true;
  const hlen = Math.hypot(dir[0], dir[2]);
  if (hlen < 1e-4) return true;
  return (dx * dir[0] + dz * dir[2]) / (dist * hlen) > -0.18;
}

function drawPart(part) {
  if (!part.count) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, part.vbo);
  gl.vertexAttribPointer(A.pos, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribPointer(A.uv, 2, gl.FLOAT, false, 24, 12);
  gl.vertexAttribPointer(A.light, 1, gl.FLOAT, false, 24, 20);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.ibo);
  gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_INT, 0);
}

/* Wireframe cube used to outline whatever block you are pointing at. */
const outlineVBO = gl.createBuffer();
{
  const e = [[0,0,0],[1,0,0],[1,0,1],[0,0,1],[0,1,0],[1,1,0],[1,1,1],[0,1,1]];
  const pairs = [0,1,1,2,2,3,3,0, 4,5,5,6,6,7,7,4, 0,4,1,5,2,6,3,7];
  const v = [];
  for (const i of pairs) v.push(e[i][0], e[i][1], e[i][2]);
  gl.bindBuffer(gl.ARRAY_BUFFER, outlineVBO);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
}

/* ------------------------------------------------------------------ *
 * Player
 * ------------------------------------------------------------------ */
const EYE = 1.62, HALF_W = 0.3, BODY_H = 1.8;
const GRAVITY = 28, JUMP = 8.4, WALK = 4.6, SPRINT = 7.4, FLY = 13;

const player = {
  pos: [WX / 2 + 0.5, WY - 1, WZ / 2 + 0.5],
  vel: [0, 0, 0],
  yaw: 0, pitch: 0,
  onGround: false, flying: false, inWater: false
};

// Spiral out from the middle of the map until we find dry, open ground.
function spawn() {
  const cx = WX >> 1, cz = WZ >> 1;
  for (let r = 0; r < Math.max(cx, cz); r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 1 || z < 1 || x >= WX - 1 || z >= WZ - 1) continue;
        for (let y = WY - 3; y > SEA; y--) {
          if (!isSolid(getBlock(x, y, z))) continue;
          if (getBlock(x, y + 1, z) !== AIR || getBlock(x, y + 2, z) !== AIR) break;
          player.pos = [x + 0.5, y + 1.02, z + 0.5];
          return;
        }
      }
    }
  }
  player.pos = [WX / 2 + 0.5, WY - 2, WZ / 2 + 0.5];
}

function solidAt(x, y, z) { return isSolid(getBlock(x, y, z)); }

// Move along one axis and push back out of anything we ended up inside.
function moveAxis(axis, amount) {
  if (!amount) return;
  player.pos[axis] += amount;
  const p = player.pos;
  const lo = [Math.floor(p[0] - HALF_W), Math.floor(p[1]), Math.floor(p[2] - HALF_W)];
  const hi = [Math.floor(p[0] + HALF_W), Math.floor(p[1] + BODY_H), Math.floor(p[2] + HALF_W)];

  for (let y = lo[1]; y <= hi[1]; y++) {
    for (let z = lo[2]; z <= hi[2]; z++) {
      for (let x = lo[0]; x <= hi[0]; x++) {
        if (!solidAt(x, y, z)) continue;
        const cell = [x, y, z][axis];
        if (amount > 0) {
          p[axis] = cell - (axis === 1 ? BODY_H : HALF_W) - 1e-4;
        } else {
          p[axis] = cell + 1 + (axis === 1 ? 0 : HALF_W) + 1e-4;
          if (axis === 1) player.onGround = true;
        }
        player.vel[axis] = 0;
        return;
      }
    }
  }
}

function headBlock() {
  return getBlock(Math.floor(player.pos[0]), Math.floor(player.pos[1] + EYE), Math.floor(player.pos[2]));
}

function updatePlayer(dt) {
  const feet = getBlock(Math.floor(player.pos[0]), Math.floor(player.pos[1] + 0.1), Math.floor(player.pos[2]));
  player.inWater = feet === WATER || headBlock() === WATER;

  let fx = 0, fz = 0;
  if (keys['KeyW']) fz += 1;
  if (keys['KeyS']) fz -= 1;
  if (keys['KeyA']) fx -= 1;
  if (keys['KeyD']) fx += 1;
  const len = Math.hypot(fx, fz);
  if (len) { fx /= len; fz /= len; }

  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  // yaw 0 looks down -Z
  const dx = fx * cos - fz * sin;
  const dz = fx * sin + fz * -cos;

  let speed = player.flying ? FLY : (keys['ControlLeft'] ? SPRINT : WALK);
  if (player.inWater && !player.flying) speed *= 0.6;
  if (keys['ShiftLeft'] && !player.flying) speed *= 0.35;

  player.vel[0] = dx * speed;
  player.vel[2] = dz * speed;

  if (player.flying) {
    let vy = 0;
    if (keys['Space']) vy += 1;
    if (keys['ShiftLeft']) vy -= 1;
    player.vel[1] = vy * FLY * 0.7;
  } else if (player.inWater) {
    player.vel[1] += -GRAVITY * 0.25 * dt;
    if (keys['Space']) player.vel[1] = 4.2;
    player.vel[1] = Math.max(player.vel[1], -4);
  } else {
    player.vel[1] -= GRAVITY * dt;
    if (keys['Space'] && player.onGround) { player.vel[1] = JUMP; player.onGround = false; }
    player.vel[1] = Math.max(player.vel[1], -50);
  }

  player.onGround = false;
  moveAxis(1, player.vel[1] * dt);
  moveAxis(0, player.vel[0] * dt);
  moveAxis(2, player.vel[2] * dt);

  // Keep the player inside the world rather than sliding off the edge.
  player.pos[0] = Math.min(WX - 0.31, Math.max(0.31, player.pos[0]));
  player.pos[2] = Math.min(WZ - 0.31, Math.max(0.31, player.pos[2]));
  if (player.pos[1] < -5) { spawn(); player.vel = [0, 0, 0]; }
}

/* ------------------------------------------------------------------ *
 * Looking at blocks
 * ------------------------------------------------------------------ */
function lookDir() {
  const cp = Math.cos(player.pitch);
  return [-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp];
}

// Amanatides & Woo grid traversal.
function raycast(maxDist) {
  const o = [player.pos[0], player.pos[1] + EYE, player.pos[2]];
  const d = lookDir();
  let x = Math.floor(o[0]), y = Math.floor(o[1]), z = Math.floor(o[2]);
  const step = [Math.sign(d[0]), Math.sign(d[1]), Math.sign(d[2])];
  const cell = [x, y, z];
  const tDelta = [0, 0, 0], tMax = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) { tDelta[i] = Infinity; tMax[i] = Infinity; continue; }
    tDelta[i] = Math.abs(1 / d[i]);
    const bound = step[i] > 0 ? cell[i] + 1 - o[i] : o[i] - cell[i];
    tMax[i] = bound * tDelta[i];
  }

  let face = [0, 0, 0], t = 0;
  while (t <= maxDist) {
    const b = getBlock(x, y, z);
    if (b !== AIR && b !== WATER) {
      return { x, y, z, block: b, nx: face[0], ny: face[1], nz: face[2] };
    }
    if (tMax[0] < tMax[1] && tMax[0] < tMax[2]) {
      t = tMax[0]; x += step[0]; tMax[0] += tDelta[0]; face = [-step[0], 0, 0];
    } else if (tMax[1] < tMax[2]) {
      t = tMax[1]; y += step[1]; tMax[1] += tDelta[1]; face = [0, -step[1], 0];
    } else {
      t = tMax[2]; z += step[2]; tMax[2] += tDelta[2]; face = [0, 0, -step[2]];
    }
  }
  return null;
}

function intersectsPlayer(x, y, z) {
  const p = player.pos;
  return x + 1 > p[0] - HALF_W && x < p[0] + HALF_W &&
         y + 1 > p[1] && y < p[1] + BODY_H &&
         z + 1 > p[2] - HALF_W && z < p[2] + HALF_W;
}

function editBlock(x, y, z, b) {
  setBlockRaw(x, y, z, b);
  markDirty(x, y, z);
}

function breakBlock() {
  const hit = raycast(6);
  if (!hit) return;
  if (BLOCKS[hit.block] && BLOCKS[hit.block].unbreakable) return;
  editBlock(hit.x, hit.y, hit.z, AIR);
}

function placeBlock() {
  const hit = raycast(6);
  if (!hit) return;
  const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
  if (y < 0 || y >= WY) return;
  const there = getBlock(x, y, z);
  if (there !== AIR && there !== WATER) return;
  if (intersectsPlayer(x, y, z)) return;
  editBlock(x, y, z, HOTBAR[selected]);
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */
const keys = Object.create(null);
let selected = 0, paused = true;
let breakHeld = false, placeHeld = false, breakCd = 0, placeCd = 0;

const menu = document.getElementById('menu');
const loadingEl = document.getElementById('loading');
const debugEl = document.getElementById('debug');
const itemNameEl = document.getElementById('itemname');

addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyF') player.flying = !player.flying;
  if (e.code.startsWith('Digit')) {
    const n = +e.code.slice(5);
    if (n >= 1 && n <= HOTBAR.length) selectSlot(n - 1);
  }
  if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

canvas.addEventListener('contextmenu', e => e.preventDefault());

addEventListener('mousedown', e => {
  if (paused) return;
  if (e.button === 0) { breakHeld = true; breakBlock(); breakCd = 0.28; }
  if (e.button === 2) { placeHeld = true; placeBlock(); placeCd = 0.22; }
});
addEventListener('mouseup', e => {
  if (e.button === 0) breakHeld = false;
  if (e.button === 2) placeHeld = false;
});

addEventListener('mousemove', e => {
  if (paused) return;
  const s = 0.0022;
  player.yaw -= e.movementX * s;
  player.pitch -= e.movementY * s;
  const lim = Math.PI / 2 - 0.001;
  player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
});

addEventListener('wheel', e => {
  if (paused) return;
  selectSlot((selected + (e.deltaY > 0 ? 1 : -1) + HOTBAR.length) % HOTBAR.length);
}, { passive: true });

document.getElementById('play').addEventListener('click', () => canvas.requestPointerLock());
document.addEventListener('pointerlockchange', () => {
  paused = document.pointerLockElement !== canvas;
  menu.classList.toggle('hidden', !paused);
  if (paused) { breakHeld = placeHeld = false; for (const k in keys) keys[k] = false; }
});

/* ------------------------------------------------------------------ *
 * Hotbar
 * ------------------------------------------------------------------ */
const hotbarEl = document.getElementById('hotbar');
// A little isometric cube, the way an inventory slot should look.
function drawIcon(ctx, block) {
  const [top, , side] = BLOCKS[block].tiles;
  // Unit square -> parallelogram, so each face is one drawImage.
  const face = (tile, ox, oy, ux, uy, vx, vy) => {
    ctx.save();
    ctx.setTransform(ux, uy, vx, vy, ox, oy);
    ctx.drawImage(atlasCanvas, (tile % ATLAS_TILES) * TILE, ((tile / ATLAS_TILES) | 0) * TILE,
                  TILE, TILE, 0, 0, 1, 1);
    ctx.restore();
  };
  const shade = (alpha, pts) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fill();
  };
  face(top, 2, 11, 14, -8, 14, 8);              // top
  face(side, 2, 11, 14, 8, 0, 10);              // left
  face(side, 16, 19, 14, -8, 0, 10);            // right
  shade(0.20, [[2, 11], [16, 19], [16, 29], [2, 21]]);
  shade(0.36, [[16, 19], [30, 11], [30, 21], [16, 29]]);
}

HOTBAR.forEach((block, i) => {
  const slot = document.createElement('div');
  slot.className = 'slot' + (i === 0 ? ' active' : '');
  const icon = document.createElement('canvas');
  icon.width = icon.height = 32;
  const ictx = icon.getContext('2d');
  ictx.imageSmoothingEnabled = false;
  drawIcon(ictx, block);
  const num = document.createElement('div');
  num.className = 'num';
  num.textContent = i + 1;
  slot.append(icon, num);
  hotbarEl.appendChild(slot);
});

function selectSlot(i) {
  selected = i;
  [...hotbarEl.children].forEach((el, n) => el.classList.toggle('active', n === i));
  itemNameEl.textContent = BLOCKS[HOTBAR[i]].name;
  itemNameEl.classList.add('show');
  clearTimeout(selectSlot.timer);
  selectSlot.timer = setTimeout(() => itemNameEl.classList.remove('show'), 1200);
}

/* ------------------------------------------------------------------ *
 * Frame loop
 * ------------------------------------------------------------------ */
const proj = mat4(), view = mat4(), mvp = mat4(), model = mat4(), outlineMVP = mat4();

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.floor(innerWidth * dpr), h = Math.floor(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
addEventListener('resize', resize);

let last = performance.now(), fps = 0, fpsAcc = 0, fpsFrames = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 0.4) { fps = Math.round(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }

  if (!paused) {
    updatePlayer(dt);
    breakCd -= dt; placeCd -= dt;
    if (breakHeld && breakCd <= 0) { breakBlock(); breakCd = 0.22; }
    if (placeHeld && placeCd <= 0) { placeBlock(); placeCd = 0.2; }
  }

  // Remesh a couple of chunks per frame so edits never stall the loop.
  let budget = 2;
  for (const c of chunks) {
    if (!c.dirty) continue;
    rebuild(c);
    if (--budget === 0) break;
  }

  resize();
  gl.viewport(0, 0, canvas.width, canvas.height);

  const underwater = headBlock() === WATER;
  const sky = underwater ? [0.10, 0.26, 0.52] : SKY;
  gl.clearColor(sky[0], sky[1], sky[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);   // faces are already culled during meshing

  const eye = [player.pos[0], player.pos[1] + EYE, player.pos[2]];
  const d = lookDir();
  perspective(proj, Math.PI / 2.6, canvas.width / canvas.height, 0.1, 400);
  lookAt(view, eye, [eye[0] + d[0], eye[1] + d[1], eye[2] + d[2]], [0, 1, 0]);
  multiply(mvp, proj, view);

  gl.useProgram(chunkProg);
  gl.uniformMatrix4fv(U.mvp, false, mvp);
  gl.uniform3fv(U.eye, eye);
  gl.uniform3fv(U.fog, sky);
  gl.uniform2fv(U.fogRange, underwater ? FOG_WATER : FOG_AIR);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(U.tex, 0);
  gl.enableVertexAttribArray(A.pos);
  gl.enableVertexAttribArray(A.uv);
  gl.enableVertexAttribArray(A.light);

  const visible = chunks.filter(c => chunkVisible(c, eye, d));

  gl.disable(gl.BLEND);
  for (const c of visible) drawPart(c.opaque);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  for (const c of visible) drawPart(c.alpha);
  gl.disable(gl.BLEND);

  gl.disableVertexAttribArray(A.pos);
  gl.disableVertexAttribArray(A.uv);
  gl.disableVertexAttribArray(A.light);

  const hit = paused ? null : raycast(6);
  if (hit) {
    model.fill(0);
    model[0] = model[5] = model[10] = 1.004;
    model[12] = hit.x - 0.002; model[13] = hit.y - 0.002; model[14] = hit.z - 0.002;
    model[15] = 1;
    multiply(outlineMVP, mvp, model);
    gl.useProgram(lineProg);
    gl.uniformMatrix4fv(LU.mvp, false, outlineMVP);
    gl.uniform4f(LU.color, 0, 0, 0, 0.55);
    gl.bindBuffer(gl.ARRAY_BUFFER, outlineVBO);
    gl.enableVertexAttribArray(LU.pos);
    gl.vertexAttribPointer(LU.pos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, 24);
    gl.disableVertexAttribArray(LU.pos);
  }

  debugEl.textContent =
    `${fps} fps\n` +
    `xyz ${player.pos[0].toFixed(1)} ${player.pos[1].toFixed(1)} ${player.pos[2].toFixed(1)}\n` +
    `${player.flying ? 'flying' : player.inWater ? 'swimming' : player.onGround ? 'on ground' : 'falling'}\n` +
    `looking at ${hit ? BLOCKS[hit.block].name : '-'}`;
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
function boot() {
  generateWorld();
  spawn();
  for (const c of chunks) rebuild(c);
  selectSlot(0);
  loadingEl.classList.add('hidden');
  menu.classList.remove('hidden');
  resize();
  requestAnimationFrame(frame);
}
// One paint of the loading screen before the generator blocks the thread.
requestAnimationFrame(() => setTimeout(boot, 0));
