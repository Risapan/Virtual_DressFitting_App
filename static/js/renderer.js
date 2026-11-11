// WebGL2 compositor: camera frame -> dress mesh -> arms re-drawn on top
// (so hands/forearms in front of the body correctly cover the dress).

const VS_QUAD = `#version 300 es
in vec2 a; out vec2 uv;
void main(){ uv = vec2(a.x*.5+.5, .5-a.y*.5); gl_Position = vec4(a,0.,1.); }`;

const FS_VIDEO = `#version 300 es
precision mediump float; in vec2 uv; uniform sampler2D u_video; out vec4 o;
void main(){ o = vec4(texture(u_video, uv).rgb, 1.); }`;

const VS_MESH = `#version 300 es
in vec2 a_pos; in vec2 a_uv; in float a_shade;
uniform vec2 u_res; out vec2 uv; out float shade;
void main(){
  uv = a_uv; shade = a_shade;
  gl_Position = vec4(a_pos.x/u_res.x*2.-1., 1.-a_pos.y/u_res.y*2., 0., 1.);
}`;

const FS_MESH = `#version 300 es
precision mediump float; in vec2 uv; in float shade;
uniform sampler2D u_tex; uniform float u_alpha; uniform float u_tint; out vec4 o;
void main(){
  vec4 c = texture(u_tex, uv);              // premultiplied
  o = vec4(c.rgb * shade * u_tint, c.a) * u_alpha;
}`;

// arms: video pixels where (person mask) AND (inside an arm capsule)
const FS_ARMS = `#version 300 es
precision highp float; in vec2 uv;
uniform sampler2D u_video; uniform sampler2D u_mask;
uniform vec2 u_res; uniform vec4 u_seg[6]; uniform float u_rad[6]; uniform int u_nseg;
out vec4 o;
float sd(vec2 p, vec2 a, vec2 b){
  vec2 pa = p-a, ba = b-a; float h = clamp(dot(pa,ba)/max(dot(ba,ba),1e-3),0.,1.);
  return length(pa - ba*h);
}
void main(){
  vec2 p = uv * u_res; float cap = 0.;
  for (int i=0;i<6;i++){ if(i>=u_nseg) break;
    float d = sd(p, u_seg[i].xy, u_seg[i].zw);
    cap = max(cap, 1. - smoothstep(u_rad[i]*.75, u_rad[i], d));
  }
  float m = smoothstep(.35, .75, texture(u_mask, uv).r);
  float a = cap * m;
  o = vec4(texture(u_video, uv).rgb * a, a);
}`;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.pVideo = program(gl, VS_QUAD, FS_VIDEO);
    this.pMesh = program(gl, VS_MESH, FS_MESH);
    this.pArms = program(gl, VS_QUAD, FS_ARMS);

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.texVideo = texture(gl);
    this.texMask = texture(gl);
    this.maskBuf = null;
    this.meshBufs = new Map(); // cloth -> buffers
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  uploadImage(img) {
    const gl = this.gl, t = texture(gl);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    return t;
  }

  deleteTexture(t) { if (t) this.gl.deleteTexture(t); }

  drawVideo(video) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    this.useQuad(this.pVideo);
    gl.uniform1i(gl.getUniformLocation(this.pVideo, "u_video"), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  drawCloth(cloth, tex, alpha, tint) {
    if (!cloth.ready || alpha <= 0.002 || !tex) return;
    const gl = this.gl, p = this.pMesh;
    let b = this.meshBufs.get(cloth);
    if (!b) {
      b = { pos: gl.createBuffer(), uv: gl.createBuffer(), shade: gl.createBuffer(), idx: gl.createBuffer() };
      gl.bindBuffer(gl.ARRAY_BUFFER, b.uv);
      gl.bufferData(gl.ARRAY_BUFFER, cloth.uv, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cloth.indices, gl.STATIC_DRAW);
      this.meshBufs.set(cloth, b);
    }
    gl.useProgram(p);
    attrib(gl, p, "a_pos", b.pos, cloth.pos, 2);
    attrib(gl, p, "a_uv", b.uv, null, 2);
    attrib(gl, p, "a_shade", b.shade, cloth.shade, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(p, "u_tex"), 0);
    gl.uniform2f(gl.getUniformLocation(p, "u_res"), this.canvas.width, this.canvas.height);
    gl.uniform1f(gl.getUniformLocation(p, "u_alpha"), alpha);
    gl.uniform1f(gl.getUniformLocation(p, "u_tint"), tint);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, cloth.indices.length, gl.UNSIGNED_SHORT, 0);
    // detach attribute arrays so the quad programs start clean
    for (const name of ["a_pos", "a_uv", "a_shade"]) {
      const loc = gl.getAttribLocation(p, name);
      if (loc >= 0) gl.disableVertexAttribArray(loc);
    }
  }

  /** mask: MPMask from MediaPipe; segs: [[x1,y1,x2,y2,radius], ...] in camera px */
  drawArms(mask, segs) {
    if (!mask || !segs.length) return;
    const gl = this.gl, p = this.pArms;
    const w = mask.width, h = mask.height;
    const f = mask.getAsFloat32Array();
    if (!this.maskBuf || this.maskBuf.length !== f.length) this.maskBuf = new Uint8Array(f.length);
    const m = this.maskBuf;
    for (let i = 0; i < f.length; i++) m[i] = f[i] * 255;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, m);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);

    this.useQuad(p);
    gl.uniform1i(gl.getUniformLocation(p, "u_video"), 0);
    gl.uniform1i(gl.getUniformLocation(p, "u_mask"), 1);
    gl.uniform2f(gl.getUniformLocation(p, "u_res"), this.canvas.width, this.canvas.height);
    const n = Math.min(segs.length, 6);
    const sv = new Float32Array(24), rv = new Float32Array(6);
    for (let i = 0; i < n; i++) { sv.set(segs[i].slice(0, 4), i * 4); rv[i] = segs[i][4]; }
    gl.uniform4fv(gl.getUniformLocation(p, "u_seg"), sv);
    gl.uniform1fv(gl.getUniformLocation(p, "u_rad"), rv);
    gl.uniform1i(gl.getUniformLocation(p, "u_nseg"), n);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  useQuad(p) {
    const gl = this.gl;
    gl.useProgram(p);
    const loc = gl.getAttribLocation(p, "a");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }
}

function attrib(gl, p, name, buf, data, size) {
  const loc = gl.getAttribLocation(p, name);
  if (loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  if (data) gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

function texture(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
