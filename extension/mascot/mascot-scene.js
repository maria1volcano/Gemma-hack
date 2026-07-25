/*
 * KidGuard mascot - Three.js scene (renderer, camera, lights, GLB, moods).
 *
 * Classic script, no import/export: content scripts cannot be ES modules.
 * Vendored build: three r137 (extension/lib/three.min.js, UMD -> global THREE)
 * plus the legacy examples/js loader (extension/lib/GLTFLoader.js ->
 * THREE.GLTFLoader). r137 has NO ColorManagement / outputColorSpace, so the
 * correct colour pipeline here is renderer.outputEncoding = THREE.sRGBEncoding
 * with authored colours converted via Color.convertSRGBToLinear().
 */
(function () {
  "use strict";

  var NS = (window.KidGuardMascotNS = window.KidGuardMascotNS || {});
  if (NS.createScene) return;

  var MOODS = { idle: 1, worry: 1, happy: 1, point: 1 };

  var CLIP_HINTS = {
    idle: ["idle", "breath", "breathing", "stand", "standing", "rest", "loop"],
    happy: ["happy", "wave", "celebrat", "jump", "cheer", "yes", "dance"],
    worry: ["worry", "worried", "fear", "afraid", "concern", "no", "sad", "scare"],
    point: ["point", "gesture", "look", "aim", "show"]
  };

  function pickClip(clips, mood) {
    var hints = CLIP_HINTS[mood] || [];
    for (var h = 0; h < hints.length; h++) {
      for (var c = 0; c < clips.length; c++) {
        var name = String(clips[c].name || "").toLowerCase();
        if (name.indexOf(hints[h]) !== -1) return clips[c];
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ GLB wrapper */

  // Wraps a loaded glTF into the same contract as the procedural capybara:
  //   { object, update(ctx), dispose(), isProcedural, hasClips }
  function makeGlbCharacter(THREE, gltf) {
    var root = new THREE.Group();
    var inner = new THREE.Group();
    root.add(inner);
    inner.add(gltf.scene);

    // Orientation normalisation: we assume Y-up and +Z forward. If the model is
    // clearly longer along X than along Z it was most likely exported facing
    // +X, so turn it a quarter turn to face the camera.
    var probe = new THREE.Box3().setFromObject(gltf.scene);
    var psize = probe.getSize(new THREE.Vector3());
    if (psize.z > 0.0001 && psize.x > psize.z * 1.6) gltf.scene.rotation.y = -Math.PI / 2;

    inner.rotation.y = -0.42; // same three-quarter framing as the fallback

    var clips = (gltf.animations || []).slice();
    var mixer = clips.length ? new THREE.AnimationMixer(gltf.scene) : null;
    var actions = {};
    var current = null;

    if (mixer) {
      Object.keys(MOODS).forEach(function (mood) {
        var clip = pickClip(clips, mood);
        if (clip) {
          var a = mixer.clipAction(clip);
          a.loop = THREE.LoopRepeat;
          actions[mood] = a;
        }
      });
      if (!actions.idle && clips.length) {
        actions.idle = mixer.clipAction(clips[0]);
        actions.idle.loop = THREE.LoopRepeat;
      }
    }

    function playFor(mood) {
      var next = actions[mood] || actions.idle || null;
      if (!next || next === current) return; // never restart a playing clip
      next.reset();
      next.setEffectiveWeight(1);
      next.fadeIn(0.28);
      next.play();
      if (current) current.fadeOut(0.28);
      current = next;
    }

    var st = { lean: 0, yaw: 0, bob: 0, mood: null };

    function update(ctx) {
      var dt = Math.min(ctx.dt, 0.05);
      var mood = ctx.mood || "idle";
      if (mood !== st.mood) {
        st.mood = mood;
        playFor(mood);
      }
      if (mixer) mixer.update(dt);

      // Procedural motion on top of (or instead of) the clips: this is what
      // makes the moods readable when the GLB only ships an idle loop.
      var amp = ctx.reduced ? 0.12 : 1;
      var t = ctx.time;
      var point = ctx.point || { active: false, yaw: 0, pitch: 0 };
      var tYaw = 0;
      var tLean = 0;
      var tBob = 0;
      var hasMoodClip = !!actions[mood];

      if (mood === "point") {
        tYaw = (point.active ? point.yaw : 0) * 0.8;
        tLean = 0.16 + (point.active ? Math.abs(point.pitch) : 0) * 0.1;
      } else if (mood === "worry") {
        tYaw = Math.sin(t * 5.2) * 0.2 * amp;
        tLean = -0.14;
      } else if (mood === "happy") {
        if (!hasMoodClip) tBob = Math.abs(Math.sin(t * 4.4)) * 0.12 * amp;
        tYaw = Math.sin(t * 2.2) * 0.2 * amp;
      } else {
        if (!hasMoodClip) tBob = Math.sin(t * 1.35) * 0.035 * amp;
        tYaw = Math.sin(t * 0.42) * 0.1 * amp;
      }

      var k = 1 - Math.exp(-(ctx.reduced ? 26 : 7.5) * dt);
      st.yaw += (tYaw - st.yaw) * k;
      st.lean += (tLean - st.lean) * k;
      st.bob += (tBob - st.bob) * (1 - Math.exp(-18 * dt));

      inner.rotation.y = -0.42 + st.yaw;
      inner.rotation.x = st.lean;
      inner.position.y = st.bob;
    }

    function dispose() {
      if (mixer) {
        try {
          mixer.stopAllAction();
          mixer.uncacheRoot(gltf.scene);
        } catch (e) {}
      }
      gltf.scene.traverse(function (o) {
        if (o.geometry) {
          try {
            o.geometry.dispose();
          } catch (e) {}
        }
        var m = o.material;
        if (!m) return;
        var list = Array.isArray(m) ? m : [m];
        for (var i = 0; i < list.length; i++) {
          var mat = list[i];
          for (var key in mat) {
            var v = mat[key];
            if (v && v.isTexture) {
              try {
                v.dispose();
              } catch (e) {}
            }
          }
          try {
            mat.dispose();
          } catch (e) {}
        }
      });
    }

    return {
      object: root,
      fitTargets: [inner],
      update: update,
      dispose: dispose,
      isProcedural: false,
      hasClips: clips.length > 0,
      clipNames: clips.map(function (c) {
        return c.name;
      })
    };
  }

  /* ------------------------------------------------------------------ scene */

  /**
   * opts = {
   *   container, width, height, glbUrl, reduced,
   *   onFirstFrame(), onStatus(text), onError(text)
   * }
   */
  NS.createScene = function (opts) {
    opts = opts || {};
    var THREE = window.THREE;
    if (!THREE || !THREE.WebGLRenderer) {
      if (opts.onError) opts.onError("Three.js global not found (check lib/three.min.js load order)");
      return null;
    }

    var width = opts.width || 150;
    var height = opts.height || 190;
    var reduced = !!opts.reduced;

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        powerPreference: "low-power"
      });
    } catch (err) {
      if (opts.onError) opts.onError("WebGL unavailable: " + (err && err.message ? err.message : err));
      return null;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height, true);
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);
    renderer.outputEncoding = THREE.sRGBEncoding; // r137 pipeline (no outputColorSpace)
    renderer.shadowMap.enabled = false; // the fake contact shadow is far cheaper

    var canvas = renderer.domElement;
    canvas.className = "kgm-canvas";
    canvas.style.pointerEvents = "none";
    canvas.style.display = "block";
    canvas.setAttribute("aria-hidden", "true");

    var scene = new THREE.Scene();

    var camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
    camera.position.set(0, 0.55, 6);
    camera.lookAt(0, 0, 0);

    // Soft studio-ish lighting: sky/ground bounce + warm key + cool fill.
    var hemi = new THREE.HemisphereLight(0xffffff, 0x8f7f6a, 0.9);
    scene.add(hemi);
    var key = new THREE.DirectionalLight(0xfff1dc, 1.05);
    key.position.set(2.2, 3.4, 2.6);
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xbcd4ff, 0.35);
    fill.position.set(-2.6, 0.8, -1.4);
    scene.add(fill);
    var amb = new THREE.AmbientLight(0xffffff, 0.22);
    scene.add(amb);

    var entranceGroup = new THREE.Group();
    scene.add(entranceGroup);
    var fitGroup = new THREE.Group();
    entranceGroup.add(fitGroup);

    var character = null;
    var measuredBox = null;
    var usingGlb = false;

    function measure(ch) {
      var targets = ch.fitTargets && ch.fitTargets.length ? ch.fitTargets : [ch.object];
      var box = new THREE.Box3();
      var tmp = new THREE.Box3();
      var empty = true;
      for (var i = 0; i < targets.length; i++) {
        tmp.setFromObject(targets[i]);
        if (tmp.isEmpty()) continue;
        if (empty) {
          box.copy(tmp);
          empty = false;
        } else {
          box.union(tmp);
        }
      }
      return empty ? null : box;
    }

    // Auto-centre + auto-scale so any model (or a wrongly scaled GLB) is framed
    // without clipped limbs. The box is measured with the base three-quarter
    // yaw already applied, so size.x is the real on-screen width; the margins
    // below absorb the extra yaw of the moods, the happy bounce and the
    // overshoot of the entrance animation.
    var FILL = 0.84;
    var YAW_MARGIN = 1.12;
    var BOUNCE_MARGIN = 1.09;
    function fit() {
      if (!character || !measuredBox) return;
      fitGroup.position.set(0, 0, 0);
      fitGroup.scale.set(1, 1, 1);
      var size = measuredBox.getSize(new THREE.Vector3());
      var center = measuredBox.getCenter(new THREE.Vector3());
      var dist = camera.position.length();
      var tanV = Math.tan((camera.fov * Math.PI) / 360);
      var tanH = tanV * camera.aspect;
      var hx = (Math.max(size.x, size.z * 0.6, 0.0001) * YAW_MARGIN) / 2;
      var hy = (Math.max(size.y, 0.0001) * BOUNCE_MARGIN) / 2;
      // Nearest depth after scaling, so perspective magnification of the parts
      // closest to the camera (muzzle, front hooves) cannot clip the canvas.
      var hz = Math.max(size.z, size.x, 0.0001) / 2;
      var sx = (FILL * tanH * dist) / (hx + FILL * tanH * hz);
      var sy = (FILL * tanV * dist) / (hy + FILL * tanV * hz);
      var s = Math.min(sx, sy);
      if (!isFinite(s) || s <= 0) s = 1;
      fitGroup.scale.setScalar(s);
      fitGroup.position.set(-center.x * s, -center.y * s, -center.z * s);
    }

    function setCharacter(ch) {
      if (!ch) return;
      if (character) {
        fitGroup.remove(character.object);
        try {
          character.dispose();
        } catch (e) {}
      }
      character = ch;
      measuredBox = measure(ch);
      fitGroup.add(ch.object);
      fit();
    }

    setCharacter(NS.buildProceduralCapybara(THREE));

    /* ------------------------------------------------------------ GLB load */

    function tryLoadGlb(url) {
      if (!url) return;
      if (typeof THREE.GLTFLoader !== "function") return;
      // Probe first so a missing file never turns into a red console error.
      var probe;
      try {
        probe = fetch(url, { method: "GET", cache: "force-cache" });
      } catch (e) {
        return;
      }
      probe
        .then(function (res) {
          if (!res || !res.ok) throw new Error("no glb");
          return res.arrayBuffer();
        })
        .then(function (buf) {
          if (disposed || !buf || buf.byteLength < 64) throw new Error("empty glb");
          var loader = new THREE.GLTFLoader();
          var base = url.slice(0, url.lastIndexOf("/") + 1);
          loader.parse(
            buf,
            base,
            function (gltf) {
              if (disposed) return;
              try {
                setCharacter(makeGlbCharacter(THREE, gltf));
                usingGlb = true;
                if (opts.onStatus) {
                  opts.onStatus(
                    "GLB loaded (" + ((gltf.animations || []).length ? gltf.animations.length + " clips" : "no clips") + ")"
                  );
                }
              } catch (err) {
                if (opts.onStatus) opts.onStatus("GLB unusable, procedural capybara kept");
              }
            },
            function () {
              if (opts.onStatus) opts.onStatus("GLB parse failed, procedural capybara kept");
            }
          );
        })
        .catch(function () {
          // No assets/mascot.glb: the procedural capybara is the character.
          if (opts.onStatus) opts.onStatus("no assets/mascot.glb - procedural capybara active");
        });
    }

    tryLoadGlb(opts.glbUrl);

    /* ------------------------------------------------------------- run loop */

    var mood = "idle";
    var moodStarted = now() / 1000;
    var point = { active: false, yaw: 0, pitch: 0 };
    var raf = 0;
    var running = false;
    var disposed = false;
    var visible = true;
    var onScreen = true;
    var firstFrameSent = false;
    var lastTime = now() / 1000;
    var startTime = lastTime;

    function now() {
      return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    }

    function easeOutBack(x) {
      var c1 = 1.70158;
      var c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }

    function frame() {
      raf = 0;
      if (disposed) return;
      var t = now() / 1000;
      var dt = Math.max(0.0001, Math.min(0.05, t - lastTime));
      lastTime = t;

      // Entrance: a quick, friendly pop-in (skipped under reduced motion).
      var age = t - startTime;
      var e = reduced ? 1 : Math.min(1, age / 0.62);
      var eScale = reduced ? 1 : 0.25 + 0.75 * easeOutBack(e);
      entranceGroup.scale.setScalar(eScale);
      entranceGroup.position.y = reduced ? 0 : (1 - e) * -0.25;

      if (character) {
        character.update({
          time: t - startTime,
          dt: dt,
          mood: mood,
          moodTime: t - moodStarted,
          point: point,
          reduced: reduced
        });
      }

      renderer.render(scene, camera);

      if (!firstFrameSent) {
        firstFrameSent = true;
        if (opts.onFirstFrame) {
          try {
            opts.onFirstFrame();
          } catch (err) {}
        }
      }
      if (running) raf = requestAnimationFrame(frame);
    }

    function start() {
      if (disposed || running) return;
      running = true;
      lastTime = now() / 1000;
      if (!raf) raf = requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function syncRunning() {
      if (disposed) return;
      if (visible && onScreen && !document.hidden) start();
      else stop();
    }

    function onVisibility() {
      syncRunning();
    }
    document.addEventListener("visibilitychange", onVisibility, false);

    var io = null;
    if (typeof IntersectionObserver === "function") {
      try {
        io = new IntersectionObserver(
          function (entries) {
            for (var i = 0; i < entries.length; i++) onScreen = entries[i].isIntersecting;
            syncRunning();
          },
          { root: null, threshold: 0 }
        );
      } catch (e) {
        io = null;
      }
    }

    /* ----------------------------------------------------------- public API */

    var api = {
      canvas: canvas,
      get usingGlb() {
        return usingGlb;
      },
      get isProcedural() {
        return !character || character.isProcedural;
      },
      mount: function (parent) {
        parent.appendChild(canvas);
        if (io) {
          try {
            io.observe(canvas);
          } catch (e) {}
        }
        syncRunning();
        // Kick one frame even if the observer has not reported yet.
        if (!raf) {
          running = true;
          raf = requestAnimationFrame(frame);
        }
      },
      setMood: function (next) {
        var m = MOODS[next] ? next : "idle";
        if (m === mood) return;
        mood = m;
        moodStarted = now() / 1000;
        syncRunning();
      },
      getMood: function () {
        return mood;
      },
      setPoint: function (yaw, pitch) {
        if (yaw === null || yaw === undefined) {
          point.active = false;
          point.yaw = 0;
          point.pitch = 0;
          return;
        }
        point.active = true;
        point.yaw = Math.max(-1, Math.min(1, yaw));
        point.pitch = Math.max(-1, Math.min(1, pitch || 0));
      },
      setVisible: function (v) {
        visible = !!v;
        canvas.style.display = visible ? "block" : "none";
        syncRunning();
      },
      setReduced: function (v) {
        reduced = !!v;
      },
      resize: function (w, h) {
        width = w;
        height = h;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        fit();
        if (!running) frame(); // repaint once even while paused
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        stop();
        document.removeEventListener("visibilitychange", onVisibility, false);
        if (io) {
          try {
            io.disconnect();
          } catch (e) {}
        }
        if (character) {
          try {
            character.dispose();
          } catch (e) {}
          character = null;
        }
        scene.traverse(function (o) {
          if (o.geometry) {
            try {
              o.geometry.dispose();
            } catch (e) {}
          }
        });
        try {
          renderer.dispose();
        } catch (e) {}
        try {
          renderer.forceContextLoss();
        } catch (e) {}
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };

    return api;
  };
})();
