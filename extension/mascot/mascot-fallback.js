/*
 * KidGuard mascot - procedural capybara.
 *
 * Classic script (content scripts cannot be ES modules). Everything is hung off
 * the single namespace window.KidGuardMascotNS.
 *
 * This file is self-contained on purpose: when a real assets/mascot.glb lands,
 * mascot-scene.js stops calling buildProceduralCapybara() and this file can be
 * deleted without touching anything else.
 *
 * Units: the character is built roughly 1.9 units tall and is auto-fitted to the
 * canvas by mascot-scene.js, so absolute numbers here only matter relative to
 * each other. Forward axis is +Z (the capybara looks toward the camera).
 */
(function () {
  "use strict";

  var NS = (window.KidGuardMascotNS = window.KidGuardMascotNS || {});
  if (NS.buildProceduralCapybara) return;

  var PALETTE = {
    cream: 0xf1e5d1, // warm off-white body
    creamWarm: 0xfff4e0, // happy tint
    creamCool: 0xdfe4ea, // worry tint (cooler, desaturated)
    brown: 0x6f4b3a, // muzzle / ears / hooves
    brownDeep: 0x53372a, // nostrils, mouth
    eye: 0x141010,
    sparkle: 0xffd782,
    warn: 0xffab5c,
    shadow: 0x2a2016
  };

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Frame-rate independent approach factor.
  function approach(current, target, speed, dt) {
    return lerp(current, target, 1 - Math.exp(-speed * dt));
  }

  // Soft radial blob used for the contact shadow under the character.
  function makeShadowTexture(THREE) {
    var size = 128;
    var cv = document.createElement("canvas");
    cv.width = size;
    cv.height = size;
    var ctx = cv.getContext("2d");
    if (!ctx) return null;
    var g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.45, "rgba(255,255,255,0.45)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Build the capybara.
   * Returns the character contract shared with the GLB path in mascot-scene.js:
   *   { object, update(ctx), dispose(), isProcedural }
   * ctx = { time, dt, mood, moodTime, point:{active,yaw,pitch}, reduced, entrance }
   */
  NS.buildProceduralCapybara = function (THREE) {
    var geoms = [];
    var mats = [];
    var textures = [];

    function G(g) {
      geoms.push(g);
      return g;
    }
    function M(m) {
      mats.push(m);
      return m;
    }
    // Authored colours are sRGB; the renderer output is sRGB-encoded, so they
    // must be converted to linear once here (three r137 has no ColorManagement).
    function col(hex) {
      return new THREE.Color(hex).convertSRGBToLinear();
    }
    function mesh(geo, mat, parent, x, y, z) {
      var m = new THREE.Mesh(geo, mat);
      if (x !== undefined) m.position.set(x, y, z);
      if (parent) parent.add(m);
      return m;
    }

    /* ------------------------------------------------------------ materials */

    var creamBase = col(PALETTE.cream);
    var creamWarm = col(PALETTE.creamWarm);
    var creamCool = col(PALETTE.creamCool);

    var matCream = M(
      new THREE.MeshStandardMaterial({ color: creamBase.clone(), roughness: 0.95, metalness: 0.0 })
    );
    var matBrown = M(new THREE.MeshStandardMaterial({ color: col(PALETTE.brown), roughness: 0.85, metalness: 0.0 }));
    var matBrownDeep = M(
      new THREE.MeshStandardMaterial({ color: col(PALETTE.brownDeep), roughness: 0.8, metalness: 0.0 })
    );
    var matEye = M(new THREE.MeshStandardMaterial({ color: col(PALETTE.eye), roughness: 0.14, metalness: 0.0 }));
    var matGlint = M(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    var matSparkle = M(
      new THREE.MeshBasicMaterial({ color: col(PALETTE.sparkle), transparent: true, opacity: 0, depthWrite: false })
    );
    var matWarn = M(
      new THREE.MeshBasicMaterial({ color: col(PALETTE.warn), transparent: true, opacity: 0, depthWrite: false })
    );

    var shadowTex = makeShadowTexture(THREE);
    if (shadowTex) {
      shadowTex.encoding = THREE.sRGBEncoding;
      textures.push(shadowTex);
    }
    var matShadow = M(
      new THREE.MeshBasicMaterial({
        color: col(PALETTE.shadow),
        map: shadowTex || null,
        transparent: true,
        opacity: 0.34,
        depthWrite: false
      })
    );

    /* ----------------------------------------------------------- geometries */

    var SPH = G(new THREE.SphereGeometry(1, 26, 18)); // big smooth parts
    var SPH_LO = G(new THREE.SphereGeometry(1, 14, 10)); // small parts
    var CYL = G(new THREE.CylinderGeometry(1, 1, 1, 14));
    var SMILE = G(new THREE.TorusGeometry(0.075, 0.017, 6, 14, Math.PI));
    var PLANE = G(new THREE.CircleGeometry(1, 28));
    var RING = G(new THREE.TorusGeometry(0.8, 0.028, 6, 40));
    var SPARK = G(new THREE.IcosahedronGeometry(0.055, 0));

    /* -------------------------------------------------------------- rigging */

    var root = new THREE.Group(); // scaled + faded by the entrance animation
    var pose = new THREE.Group(); // base 3/4 yaw + mood lean/turn
    var bob = new THREE.Group(); // idle bob / bounce
    root.add(pose);
    pose.add(bob);

    var BASE_YAW = -0.42; // three-quarter view, like the reference render
    pose.rotation.y = BASE_YAW;

    // ---- contact shadow (stays flat on the ground, never bobs)
    var shadow = mesh(PLANE, matShadow, root, 0, -0.9, 0.05);
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(0.98, 1.15, 1);

    // ---- warning ring (worry mood only)
    var warnRing = mesh(RING, matWarn, root, 0, -0.885, 0.05);
    warnRing.rotation.x = -Math.PI / 2;
    warnRing.visible = false;

    // ---- body: a big barrel plus a chest bulge, very stocky
    var body = new THREE.Group();
    bob.add(body);

    var torso = mesh(SPH, matCream, body, 0, 0, -0.05);
    torso.scale.set(0.8, 0.74, 1.06);

    var chest = mesh(SPH, matCream, body, 0, -0.04, 0.6);
    chest.scale.set(0.71, 0.66, 0.5);

    var rump = mesh(SPH, matCream, body, 0, 0.02, -0.62);
    rump.scale.set(0.72, 0.69, 0.45);

    // ---- legs: short and thick, brown hooves
    var legs = [];
    function makeLeg(x, z, isFront) {
      var g = new THREE.Group();
      g.position.set(x, -0.5, z);
      body.add(g);
      var upper = mesh(CYL, matCream, g, 0, -0.13, 0);
      upper.scale.set(0.155, 0.36, 0.155);
      var knee = mesh(SPH_LO, matCream, g, 0, -0.3, 0);
      knee.scale.set(0.155, 0.12, 0.155);
      var hoof = mesh(CYL, matBrown, g, 0, -0.35, 0);
      hoof.scale.set(0.152, 0.12, 0.152);
      legs.push({ group: g, front: isFront, x: x, rest: 0 });
      return g;
    }
    makeLeg(-0.31, 0.5, true);
    makeLeg(0.31, 0.5, true);
    makeLeg(-0.35, -0.5, false);
    makeLeg(0.35, -0.5, false);

    // ---- head: sits low and close to the body
    var head = new THREE.Group();
    head.position.set(0, 0.42, 0.74);
    bob.add(head);

    var skull = mesh(SPH, matCream, head, 0, 0, 0);
    skull.scale.set(0.5, 0.46, 0.53);

    var cheek = mesh(SPH_LO, matCream, head, 0, -0.09, 0.2);
    cheek.scale.set(0.44, 0.36, 0.34);

    // blunt brown muzzle - the most recognisable capybara feature
    var muzzle = mesh(SPH, matBrown, head, 0, -0.1, 0.42);
    muzzle.scale.set(0.315, 0.265, 0.3);
    var muzzleTip = mesh(SPH_LO, matBrown, head, 0, -0.08, 0.53);
    muzzleTip.scale.set(0.26, 0.21, 0.16);

    mesh(SPH_LO, matBrownDeep, head, -0.095, -0.045, 0.655).scale.set(0.037, 0.03, 0.03);
    mesh(SPH_LO, matBrownDeep, head, 0.095, -0.045, 0.655).scale.set(0.037, 0.03, 0.03);

    var mouth = mesh(SMILE, matBrownDeep, head, 0, -0.185, 0.6);
    mouth.rotation.z = Math.PI; // torus half-arc flipped into a smile
    mouth.scale.set(1, 1, 1);

    // ---- ears: small, rounded, brown
    function makeEar(side) {
      var g = new THREE.Group();
      g.position.set(side * 0.33, 0.38, -0.02);
      g.rotation.z = side * 0.3;
      head.add(g);
      var e = mesh(SPH_LO, matBrown, g, 0, 0, 0);
      e.scale.set(0.135, 0.155, 0.075);
      var inner = mesh(SPH_LO, matBrownDeep, g, 0, -0.01, 0.05);
      inner.scale.set(0.08, 0.095, 0.03);
      return g;
    }
    var earL = makeEar(-1);
    var earR = makeEar(1);

    // ---- eyes: big, glossy, black, friendly
    function makeEye(side) {
      var g = new THREE.Group();
      g.position.set(side * 0.285, 0.095, 0.35);
      head.add(g);
      var ball = mesh(SPH_LO, matEye, g, 0, 0, 0);
      ball.scale.set(0.115, 0.12, 0.115);
      var glint = mesh(SPH_LO, matGlint, g, side * 0.035, 0.045, 0.085);
      glint.scale.set(0.032, 0.032, 0.032);
      var glint2 = mesh(SPH_LO, matGlint, g, side * -0.03, -0.035, 0.08);
      glint2.scale.set(0.016, 0.016, 0.016);
      return g;
    }
    var eyeL = makeEye(-1);
    var eyeR = makeEye(1);

    // ---- sparkles (happy mood)
    var sparkles = new THREE.Group();
    sparkles.visible = false;
    bob.add(sparkles);
    var sparkNodes = [];
    for (var i = 0; i < 6; i++) {
      var a = (i / 6) * Math.PI * 2;
      var s = mesh(SPARK, matSparkle, sparkles, Math.cos(a) * 0.75, 0.75 + (i % 3) * 0.12, Math.sin(a) * 0.55 + 0.2);
      sparkNodes.push({ mesh: s, phase: a, baseY: s.position.y });
    }

    /* ------------------------------------------------------------ animation */

    var st = {
      lean: 0, // pitch of the whole body (+ = forward)
      yaw: 0, // extra yaw on top of BASE_YAW
      headYaw: 0,
      headPitch: 0,
      headRoll: 0,
      earDroop: 0,
      squint: 0,
      legLift: 0,
      legSide: 1,
      bounce: 0,
      breath: 1,
      mouth: 1,
      warn: 0,
      spark: 0,
      tint: creamBase.clone()
    };

    var blinkTimer = 1.6 + Math.random() * 2.5;
    var blink = 0;
    var tintTmp = new THREE.Color();

    function update(ctx) {
      var dt = Math.min(ctx.dt, 0.05);
      var t = ctx.time;
      var mood = ctx.mood || "idle";
      var reduced = !!ctx.reduced;
      var moodT = ctx.moodTime || 0;
      var point = ctx.point || { active: false, yaw: 0, pitch: 0 };
      var amp = reduced ? 0.12 : 1; // prefers-reduced-motion: keep poses, drop motion

      // ---- targets per mood -------------------------------------------------
      var tLean = 0;
      var tYaw = 0;
      var tHeadYaw = 0;
      var tHeadPitch = 0;
      var tHeadRoll = 0;
      var tEar = 0;
      var tSquint = 0;
      var tLegLift = 0;
      var tMouth = 1;
      var tWarn = 0;
      var tSpark = 0;
      var tTint = creamBase;
      var bobY = 0;
      var breathe = 1;

      if (mood === "worry") {
        tLean = -0.16; // lean back, away from the scary thing
        tHeadPitch = -0.1;
        tEar = 0.55; // ears droop
        tSquint = 0.45;
        tMouth = -1; // smile flipped into a frown
        tTint = creamCool;
        tWarn = 1;
        tHeadYaw = Math.sin(t * 5.2) * 0.22 * amp; // nervous head shake
        bobY = Math.sin(t * 2.4) * 0.012 * amp;
      } else if (mood === "happy") {
        var hop = Math.abs(Math.sin(t * 4.4));
        bobY = hop * 0.11 * amp;
        tLean = 0.06;
        tYaw = Math.sin(t * 2.2) * 0.22 * amp; // little celebratory swivel
        tHeadPitch = 0.08 + Math.sin(t * 4.4) * 0.06 * amp;
        tEar = -0.35; // ears perk up
        tMouth = 1.35;
        tTint = creamWarm;
        tSpark = 1;
        breathe = 1 + hop * 0.03 * amp;
      } else if (mood === "point") {
        var py = point.active ? point.yaw : 0;
        var pp = point.active ? point.pitch : 0;
        tYaw = py * 0.62;
        tHeadYaw = py * 0.42;
        tHeadPitch = pp * 0.75;
        tHeadRoll = -py * 0.14;
        tLean = 0.17 + Math.abs(pp) * 0.1;
        tLegLift = 0.55; // front hoof raised toward the target
        tEar = -0.18;
        tMouth = 1.1;
        bobY = Math.sin(t * 2.6) * 0.01 * amp;
        st.legSide = py >= 0 ? 1 : -1;
      } else {
        // idle: slow breathing, gentle sway, small head drift
        bobY = Math.sin(t * 1.35) * 0.035 * amp;
        breathe = 1 + Math.sin(t * 1.35) * 0.022 * amp;
        tYaw = Math.sin(t * 0.42) * 0.1 * amp;
        tHeadYaw = Math.sin(t * 0.33 + 1.1) * 0.14 * amp;
        tHeadPitch = Math.sin(t * 0.51) * 0.05 * amp;
      }

      // ---- smooth toward targets -------------------------------------------
      var k = reduced ? 26 : 7.5;
      st.lean = approach(st.lean, tLean, k, dt);
      st.yaw = approach(st.yaw, tYaw, k, dt);
      st.headYaw = approach(st.headYaw, tHeadYaw, k * 1.2, dt);
      st.headPitch = approach(st.headPitch, tHeadPitch, k * 1.2, dt);
      st.headRoll = approach(st.headRoll, tHeadRoll, k, dt);
      st.earDroop = approach(st.earDroop, tEar, k, dt);
      st.squint = approach(st.squint, tSquint, k, dt);
      st.legLift = approach(st.legLift, tLegLift, k, dt);
      st.mouth = approach(st.mouth, tMouth, k, dt);
      st.warn = approach(st.warn, tWarn, 4, dt);
      st.spark = approach(st.spark, tSpark, 5, dt);
      st.bounce = approach(st.bounce, bobY, 18, dt);
      st.breath = approach(st.breath, breathe, 10, dt);
      tintTmp.copy(st.tint).lerp(tTint, 1 - Math.exp(-3 * dt));
      st.tint.copy(tintTmp);
      matCream.color.copy(st.tint);

      // ---- blinking ---------------------------------------------------------
      blinkTimer -= dt;
      if (blinkTimer <= 0) {
        blink = 1;
        blinkTimer = 2.2 + Math.random() * 3.4;
      }
      if (blink > 0) blink = Math.max(0, blink - dt * 7.5);
      var lidClose = Math.sin(Math.min(1, blink) * Math.PI); // 0 -> 1 -> 0
      var eyeScaleY = 1 - 0.9 * lidClose - 0.35 * st.squint;
      eyeL.scale.y = Math.max(0.08, eyeScaleY);
      eyeR.scale.y = Math.max(0.08, eyeScaleY);

      // ---- apply -------------------------------------------------------------
      pose.rotation.y = BASE_YAW + st.yaw;
      pose.rotation.x = st.lean;

      bob.position.y = st.bounce;
      body.scale.set(st.breath, 2 - st.breath, st.breath);

      head.rotation.set(st.headPitch, st.headYaw, st.headRoll);
      head.position.y = 0.42 + st.bounce * 0.25;

      earL.rotation.x = st.earDroop * 0.9;
      earR.rotation.x = st.earDroop * 0.9;
      earL.rotation.z = -0.3 - st.earDroop * 0.25;
      earR.rotation.z = 0.3 + st.earDroop * 0.25;

      mouth.scale.set(1 + Math.abs(st.mouth) * 0.25, Math.abs(st.mouth), 1);
      mouth.rotation.z = st.mouth >= 0 ? Math.PI : 0; // frown when negative
      mouth.position.y = -0.185 + (st.mouth < 0 ? -0.02 : 0);

      for (var li = 0; li < legs.length; li++) {
        var leg = legs[li];
        var lift = 0;
        if (leg.front && Math.sign(leg.x) === st.legSide) lift = st.legLift;
        var walkIdle = leg.front ? 0 : 0;
        leg.group.rotation.x = -lift * 0.9 + walkIdle;
        leg.group.position.y = -0.5 + lift * 0.06;
      }

      // ---- worry pulse (slow, never flashing) --------------------------------
      warnRing.visible = st.warn > 0.02;
      if (warnRing.visible) {
        var pulse = 0.5 + 0.5 * Math.sin(t * 2.0); // ~3 Hz would flash; 0.32 Hz is calm
        matWarn.opacity = st.warn * (0.08 + pulse * 0.16);
        var rs = 1 + pulse * 0.12;
        warnRing.scale.set(rs, rs, 1);
      }

      // ---- happy sparkles ----------------------------------------------------
      sparkles.visible = st.spark > 0.03;
      if (sparkles.visible) {
        matSparkle.opacity = st.spark * 0.85;
        for (var si = 0; si < sparkNodes.length; si++) {
          var sn = sparkNodes[si];
          sn.mesh.position.y = sn.baseY + Math.sin(t * 3 + sn.phase) * 0.09 * amp;
          var ss = 0.6 + 0.4 * Math.sin(t * 4 + sn.phase * 2);
          sn.mesh.scale.setScalar(Math.max(0.15, ss) * st.spark);
          sn.mesh.rotation.y = t * 1.5 + sn.phase;
        }
        sparkles.rotation.y = t * 0.6 * amp;
      }

      // ---- shadow follows the bounce ------------------------------------------
      var lift2 = Math.max(0, st.bounce);
      matShadow.opacity = 0.34 - lift2 * 0.9;
      var shs = 1 - lift2 * 0.5;
      shadow.scale.set(0.98 * shs, 1.15 * shs, 1);
    }

    function dispose() {
      for (var i = 0; i < geoms.length; i++) {
        try {
          geoms[i].dispose();
        } catch (e) {}
      }
      for (var j = 0; j < mats.length; j++) {
        try {
          mats[j].dispose();
        } catch (e) {}
      }
      for (var k2 = 0; k2 < textures.length; k2++) {
        try {
          textures[k2].dispose();
        } catch (e) {}
      }
      geoms.length = 0;
      mats.length = 0;
      textures.length = 0;
    }

    return {
      object: root,
      // The fit pass in mascot-scene.js must ignore the flat ground decals,
      // otherwise the character is framed around an invisible disc.
      fitTargets: [pose],
      update: update,
      dispose: dispose,
      isProcedural: true,
      hasClips: false
    };
  };
})();
