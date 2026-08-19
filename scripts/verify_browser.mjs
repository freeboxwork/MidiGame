import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.MIDI_GAME_URL || "http://127.0.0.1:5174/";
const executablePath =
  process.env.BROWSER_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const artifactDirectory = path.resolve("artifacts", "browser-validation");
const allViewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "desktop-4k", width: 3840, height: 2160 },
  { name: "mobile-430", width: 430, height: 900 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "mobile-320", width: 320, height: 800 },
];
const viewports = process.env.MIDI_GAME_VIEWPORT
  ? allViewports.filter((viewport) => viewport.name === process.env.MIDI_GAME_VIEWPORT)
  : allViewports;
const browserArgs = ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"];
if (process.env.MIDI_GAME_GPU !== "1") browserArgs.unshift("--disable-gpu");

await mkdir(artifactDirectory, { recursive: true });
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: browserArgs,
});

const reports = [];

try {
  for (const viewport of viewports) {
    const page = await browser.newPage();
    const errors = [];
    let hitFeedback = null;
    let holdFeedback = null;
    let liveTunnelSpeed = null;
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
    await page.goto(baseUrl, { waitUntil: "networkidle0" });
    await page.waitForFunction(
      () => document.getElementById("stateText")?.textContent.includes("채보 준비 완료"),
      { timeout: 10000 },
    );

    const metrics = await page.evaluate(() => {
      const root = document.documentElement;
      const undersizedControls = [...document.querySelectorAll("button:not(:disabled), select:not(:disabled)")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0 &&
            (rect.width < 44 || rect.height < 44)
          );
        })
        .map((element) => ({
          id: element.id || element.textContent.trim().slice(0, 24),
          width: Math.round(element.getBoundingClientRect().width),
          height: Math.round(element.getBoundingClientRect().height),
        }));

      return {
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        readyText: document.getElementById("stateText")?.textContent,
        noteCount: document.getElementById("selectionNotes")?.textContent,
        bpm: document.getElementById("selectionBpm")?.textContent,
        fileName: document.getElementById("fileName")?.textContent,
        trackName: document.getElementById("selectionTrackName")?.textContent,
        trackDisabled: document.getElementById("trackSelect")?.disabled,
        difficultyOptions: [...document.querySelectorAll("#selectionDifficulty [data-difficulty]")].map(
          (button) => ({
            value: button.dataset.difficulty,
            pressed: button.getAttribute("aria-pressed"),
          }),
        ),
        difficultyValue: document.getElementById("selectionDifficulty")?.dataset.value,
        enterEnabled: !document.getElementById("enterGameButton")?.disabled,
        selectionVisible: !document.getElementById("selectionView")?.hidden,
        gameHidden: document.getElementById("gameView")?.hidden,
        undersizedControls,
      };
    });

    await page.screenshot({
      path: path.join(artifactDirectory, `${viewport.name}.png`),
      fullPage: false,
    });

    if (metrics.scrollWidth !== metrics.clientWidth) {
      errors.push(`horizontal overflow: ${metrics.scrollWidth}px > ${metrics.clientWidth}px`);
    }
    if (metrics.undersizedControls.length) {
      errors.push(`undersized controls: ${JSON.stringify(metrics.undersizedControls)}`);
    }
    if (Number(metrics.noteCount) < 100) errors.push(`audio chart is too sparse: ${metrics.noteCount}`);
    if (metrics.fileName !== "시_분.mp3" || metrics.trackName !== "AUTO RHYTHM") {
      errors.push(`default MP3 was not analyzed: ${JSON.stringify(metrics)}`);
    }
    if (!metrics.trackDisabled) errors.push("audio analysis track should be fixed to AUTO RHYTHM");
    if (!metrics.enterEnabled) errors.push("game entry button is disabled after chart generation");
    if (!metrics.selectionVisible || !metrics.gameHidden) {
      errors.push(`initial view separation is incorrect: ${JSON.stringify(metrics)}`);
    }
    if (
      metrics.difficultyOptions.length !== 3 ||
      metrics.difficultyValue !== "standard" ||
      metrics.difficultyOptions.filter((option) => option.pressed === "true").length !== 1
    ) {
      errors.push(`difficulty picker was not initialized with three modes: ${JSON.stringify(metrics)}`);
    }

    metrics.difficultyChecks = [];
    for (const [value, label] of [
      ["calm", "CALM"],
      ["expert", "EXPERT"],
      ["standard", "STANDARD"],
    ]) {
      await page.click(`#selectionDifficulty [data-difficulty="${value}"]`);
      await page.waitForFunction(
        (expectedValue, expectedLabel) =>
          document.getElementById("selectionDifficulty")?.dataset.value === expectedValue &&
          document.getElementById("gameTrackLabel")?.textContent.endsWith(expectedLabel),
        { timeout: 5000 },
        value,
        label,
      );
      metrics.difficultyChecks.push(
        await page.evaluate(() => ({
          value: document.getElementById("selectionDifficulty")?.dataset.value,
          label: document.getElementById("gameTrackLabel")?.textContent,
          noteCount: Number(document.getElementById("selectionNotes")?.textContent.replaceAll(",", "")),
          pressed: [...document.querySelectorAll("#selectionDifficulty [data-difficulty]")]
            .filter((button) => button.getAttribute("aria-pressed") === "true")
            .map((button) => button.dataset.difficulty),
        })),
      );
    }
    const calmCheck = metrics.difficultyChecks.find((check) => check.value === "calm");
    const expertCheck = metrics.difficultyChecks.find((check) => check.value === "expert");
    if (
      metrics.difficultyChecks.some(
        (check) => check.pressed.length !== 1 || check.pressed[0] !== check.value,
      ) ||
      calmCheck.noteCount > expertCheck.noteCount
    ) {
      errors.push(`difficulty picker did not rebuild all three modes: ${JSON.stringify(metrics.difficultyChecks)}`);
    }

    await page.evaluate(() => {
      window.__backingTrackStarts = 0;
      window.__backingTrackStartAt = null;
      window.__backingTrackContext = null;
      window.__analyserReads = 0;
      const prototype = AudioBufferSourceNode.prototype;
      if (!prototype.__midiGameStartPatched) {
        const originalStart = prototype.start;
        prototype.start = function patchedStart(...args) {
          if (this.buffer?.duration > 30) window.__backingTrackStarts += 1;
          if (this.buffer?.duration > 30) {
            window.__backingTrackStartAt = args[0];
            window.__backingTrackContext = this.context;
          }
          return originalStart.apply(this, args);
        };
        prototype.__midiGameStartPatched = true;
      }
      const analyserPrototype = AnalyserNode.prototype;
      if (!analyserPrototype.__midiGameReadPatched) {
        const originalRead = analyserPrototype.getByteFrequencyData;
        analyserPrototype.getByteFrequencyData = function patchedRead(...args) {
          window.__analyserReads += 1;
          return originalRead.apply(this, args);
        };
        analyserPrototype.__midiGameReadPatched = true;
      }
    });
    await page.click("#enterGameButton");
    await page.waitForFunction(() => !document.getElementById("gameView")?.hidden, { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const gameLayout = await page.evaluate(() => {
      const root = document.documentElement;
      const canvas = document.getElementById("gameCanvas")?.getBoundingClientRect();
      const stage = document.getElementById("gameStage");
      const undersizedControls = [...document.querySelectorAll("#gameView button:not(:disabled)")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return style.display !== "none" && rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
        })
        .map((element) => ({ id: element.id || element.textContent.trim(), width: element.offsetWidth, height: element.offsetHeight }));
      return {
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        selectionHidden: document.getElementById("selectionView")?.hidden,
        gameVisible: !document.getElementById("gameView")?.hidden,
        canvasWidth: Math.round(canvas?.width || 0),
        canvasHeight: Math.round(canvas?.height || 0),
        postFxScale: document.getElementById("gameCanvas")?.dataset.postFxScale,
        rendererPixelRatio: document.getElementById("gameCanvas")?.dataset.rendererPixelRatio,
        renderTier: document.getElementById("gameCanvas")?.dataset.renderTier,
        backingWidth: document.getElementById("gameCanvas")?.width,
        backingHeight: document.getElementById("gameCanvas")?.height,
        backingTrackStarts: window.__backingTrackStarts,
        analyserReads: window.__analyserReads,
        countdownTunnelSpeed: Number(document.getElementById("gameCanvas")?.tunnelSpeedScale || 0),
        textPostFx: getComputedStyle(document.getElementById("countdown")).filter,
        postFxIncludesText:
          stage.contains(document.getElementById("countdown")) &&
          stage.contains(document.getElementById("judgement")) &&
          stage.contains(document.getElementById("effectCombo")),
        undersizedControls,
      };
    });
    if (viewport.name === "desktop-4k") {
      gameLayout.frameTiming = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const samples = [];
            let previous = performance.now();
            const sample = (now) => {
              samples.push(now - previous);
              previous = now;
              if (samples.length < 45) {
                requestAnimationFrame(sample);
                return;
              }
              const sorted = [...samples].sort((a, b) => a - b);
              resolve({
                average: Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
                p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
                max: Math.round(sorted.at(-1)),
              });
            };
            requestAnimationFrame(sample);
          }),
      );
    }
    if (!gameLayout.selectionHidden || !gameLayout.gameVisible) {
      errors.push(`game view separation is incorrect: ${JSON.stringify(gameLayout)}`);
    }
    if (gameLayout.scrollWidth !== gameLayout.clientWidth) {
      errors.push(`game view horizontal overflow: ${gameLayout.scrollWidth}px > ${gameLayout.clientWidth}px`);
    }
    if (gameLayout.canvasWidth < Math.min(280, viewport.width - 32)) {
      errors.push(`play field is too narrow: ${gameLayout.canvasWidth}px`);
    }
    if (gameLayout.canvasHeight < 460) errors.push(`play field is too short: ${gameLayout.canvasHeight}px`);
    if (gameLayout.backingTrackStarts < 1) errors.push("MP3 backing track was not scheduled");
    if (gameLayout.analyserReads < 1) errors.push("music analyser did not feed the mirror ball");
    if (gameLayout.countdownTunnelSpeed < 0.12 || gameLayout.countdownTunnelSpeed > 0.5) {
      errors.push(`line tunnel did not use its slow countdown speed: ${gameLayout.countdownTunnelSpeed}`);
    }
    if (gameLayout.textPostFx === "none" || !gameLayout.postFxIncludesText) {
      errors.push(`screen post-processing did not include game text: ${JSON.stringify(gameLayout)}`);
    }
    if (gameLayout.undersizedControls.length) {
      errors.push(`undersized game controls: ${JSON.stringify(gameLayout.undersizedControls)}`);
    }
    if (viewport.name === "desktop-4k") {
      if (
        gameLayout.renderTier !== "4k" ||
        Number(gameLayout.postFxScale) > 0.3 ||
        Number(gameLayout.rendererPixelRatio) > 0.64
      ) {
        errors.push(`4K render budget was not applied: ${JSON.stringify(gameLayout)}`);
      }
      if (gameLayout.backingWidth > 2458 || gameLayout.backingHeight > 1383) {
        errors.push(`4K canvas backing store is too large: ${JSON.stringify(gameLayout)}`);
      }
    }
    await page.screenshot({
      path: path.join(artifactDirectory, `${viewport.name}-game.png`),
      fullPage: false,
    });

    if (viewport.name === "desktop") {
      await page.waitForFunction(
        () => document.getElementById("stateText")?.textContent.includes("플레이 중"),
        { timeout: 7000 },
      );
      const liveState = await page.$eval("#sessionCode", (element) => element.textContent);
      if (liveState !== "LIVE") errors.push(`start flow did not reach LIVE: ${liveState}`);
      await new Promise((resolve) => setTimeout(resolve, 650));
      liveTunnelSpeed = await page.$eval(
        "#gameCanvas",
        (canvas) => Number(canvas.tunnelSpeedScale || 0),
      );
      if (liveTunnelSpeed < 1.05) {
        errors.push(`line tunnel did not accelerate when the music started: ${liveTunnelSpeed}`);
      }
      // The first clean K-lane target is generated at 2.804s. Use the same AudioContext
      // clock as the game so process scheduling and shader warm-up cannot shift the input.
      const millisecondsUntilTarget = await page.evaluate(() => {
        const context = window.__backingTrackContext;
        const latency = Math.min(context?.outputLatency || context?.baseLatency || 0, 0.08);
        return Math.max(0, (window.__backingTrackStartAt + 2.804 + latency - context.currentTime) * 1000);
      });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, millisecondsUntilTarget - 150)));
      await page.evaluate(() => {
        window.__hitFrameSamples = [];
        window.__measureHitFrames = true;
        let previous = performance.now();
        const sampleFrame = (now) => {
          window.__hitFrameSamples.push({ at: now, delta: now - previous });
          previous = now;
          if (window.__measureHitFrames) requestAnimationFrame(sampleFrame);
        };
        requestAnimationFrame(sampleFrame);
      });
      const finalTargetWait = await page.evaluate(() => {
        const context = window.__backingTrackContext;
        const latency = Math.min(context?.outputLatency || context?.baseLatency || 0, 0.08);
        return Math.max(0, (window.__backingTrackStartAt + 2.804 + latency - context.currentTime) * 1000 - 5);
      });
      await new Promise((resolve) => setTimeout(resolve, finalTargetWait));
      const hitStartedAt = await page.evaluate(() => performance.now());
      await page.keyboard.press("k");
      await page.waitForFunction(
        () => document.getElementById("scoreValue")?.textContent !== "000000",
        { timeout: 1000 },
      );
      const successfulHitState = await page.evaluate(() => {
        const judgementLabel = document.querySelector(".judgement-label[data-sprite]");
        const whiteFlash = judgementLabel?.querySelector(".judgement-sprite-white-flash");
        const whiteKeyframes = whiteFlash
          ?.getAnimations()
          .flatMap((animation) => animation.effect?.getKeyframes?.() || [])
          .map((keyframe) => Number.parseFloat(keyframe.opacity));
        const motionKeyframes = judgementLabel
          ?.getAnimations()
          .flatMap((animation) => animation.effect?.getKeyframes?.() || [])
          .map((keyframe) => keyframe.transform)
          .filter(Boolean);
        return {
          judgement: document.getElementById("judgement")?.textContent,
          metaText: document.getElementById("effectCombo")?.textContent,
          score: document.getElementById("scoreValue")?.textContent,
          combo: document.getElementById("comboValue")?.textContent,
          hitShakeCount: Number(document.getElementById("gameCanvas")?.dataset.hitShakeCount || 0),
          hitShakeLane: document.getElementById("gameCanvas")?.dataset.hitShakeLane,
          judgementSprite: judgementLabel?.dataset.sprite,
          judgementSpriteWidth: judgementLabel?.querySelector("img")?.naturalWidth || 0,
          judgementCssWidth: Number.parseFloat(getComputedStyle(judgementLabel).width),
          judgementWhiteOpacity: Number.parseFloat(getComputedStyle(whiteFlash).opacity),
          judgementWhiteKeyframes: whiteKeyframes,
          judgementMotionKeyframes: motionKeyframes,
          judgementBlendMode: getComputedStyle(document.getElementById("judgement")).mixBlendMode,
          mirrorFlashCount: Number(document.getElementById("gameCanvas")?.dataset.mirrorFlashCount || 0),
          mirrorFlashLane: document.getElementById("gameCanvas")?.dataset.mirrorFlashLane,
        };
      });
      await new Promise((resolve) => setTimeout(resolve, 220));
      hitFeedback = await page.evaluate((hitStartedAt, successfulHitState) => {
        const marker = document.querySelector(".hit-confirmation");
        const judgement = document.getElementById("judgement");
        const feedbackMeta = document.getElementById("effectCombo");
        const metaRect = feedbackMeta?.getBoundingClientRect();
        window.__measureHitFrames = false;
        const baselineFrames = window.__hitFrameSamples.filter((sample) => sample.at < hitStartedAt);
        const hitFrames = window.__hitFrameSamples.filter(
          (sample) => sample.at >= hitStartedAt && sample.at <= hitStartedAt + 360,
        );
        const worstHitFrame = hitFrames.reduce(
          (worst, sample) => (sample.delta > worst.delta ? sample : worst),
          { at: hitStartedAt, delta: 0 },
        );
        return {
          judgement: successfulHitState.judgement,
          markerVisible: Boolean(marker),
          markerPositionSource: marker?.dataset.positionSource,
          markerLeft: marker?.style.left,
          markerTop: marker?.style.top,
          score: successfulHitState.score,
          combo: successfulHitState.combo,
          hitShakeCount: successfulHitState.hitShakeCount,
          hitShakeLane: successfulHitState.hitShakeLane,
          judgementSprite: successfulHitState.judgementSprite,
          judgementSpriteWidth: successfulHitState.judgementSpriteWidth,
          judgementCssWidth: successfulHitState.judgementCssWidth,
          judgementWhiteOpacity: successfulHitState.judgementWhiteOpacity,
          judgementWhiteKeyframes: successfulHitState.judgementWhiteKeyframes,
          judgementMotionKeyframes: successfulHitState.judgementMotionKeyframes,
          judgementBlendMode: successfulHitState.judgementBlendMode,
          mirrorFlashCount: successfulHitState.mirrorFlashCount,
          mirrorFlashLane: successfulHitState.mirrorFlashLane,
          centeredText: judgement?.textContent,
          metaText: successfulHitState.metaText || feedbackMeta?.textContent,
          metaPosition: metaRect
            ? {
                top: Math.round(metaRect.top),
                right: Math.round(window.innerWidth - metaRect.right),
              }
            : null,
          frameTiming: {
            baselineMax: Math.round(Math.max(0, ...baselineFrames.map((sample) => sample.delta))),
            hitMax: Math.round(Math.max(0, ...hitFrames.map((sample) => sample.delta))),
            hitWorstAt: Math.round(worstHitFrame.at - hitStartedAt),
          },
        };
      }, hitStartedAt, successfulHitState);
      await page.screenshot({ path: path.join(artifactDirectory, "desktop-hit.png"), fullPage: false });
      if (!/^(Perfect|Great|Good)/.test(hitFeedback.judgement || "")) {
        errors.push(`timed first MP3 input was not successful: ${hitFeedback.judgement}`);
      }
      const wasPerfect = hitFeedback.judgement?.startsWith("Perfect");
      if (
        (wasPerfect && (hitFeedback.mirrorFlashCount !== 1 || hitFeedback.mirrorFlashLane !== "3")) ||
        (!wasPerfect && hitFeedback.mirrorFlashCount !== 0)
      ) {
        errors.push(`mirror ball flash did not follow exact judgement: ${JSON.stringify(hitFeedback)}`);
      }
      if (!hitFeedback.markerVisible) errors.push("hit confirmation marker was not created");
      if (hitFeedback.hitShakeCount !== 1 || hitFeedback.hitShakeLane !== "3") {
        errors.push(`successful judgement did not trigger lane-aware camera shake: ${JSON.stringify(hitFeedback)}`);
      }
      if (
        !["perfect", "great", "good"].includes(hitFeedback.judgementSprite) ||
        hitFeedback.judgementSpriteWidth < 1 ||
        hitFeedback.judgementCssWidth > 183 ||
        hitFeedback.judgementBlendMode !== "normal"
      ) {
        errors.push(`generated judgement sprite was not displayed: ${JSON.stringify(hitFeedback)}`);
      }
      if (
        hitFeedback.judgementWhiteOpacity < 0.95 ||
        hitFeedback.judgementWhiteKeyframes?.[0] !== 1 ||
        hitFeedback.judgementWhiteKeyframes?.at(-1) !== 0 ||
        !hitFeedback.judgementMotionKeyframes?.length ||
        hitFeedback.judgementMotionKeyframes.some((transform) => !/^scale\(/.test(transform))
      ) {
        errors.push(`judgement flash or scale-only motion was not applied: ${JSON.stringify(hitFeedback)}`);
      }
      if (hitFeedback.markerPositionSource !== "projected-3d") {
        errors.push(`hit marker did not use projected 3D coordinates: ${JSON.stringify(hitFeedback)}`);
      }
      if (hitFeedback.score === "000000" || hitFeedback.combo === "000") {
        errors.push(`score feedback did not update: ${JSON.stringify(hitFeedback)}`);
      }
      if (/ms|chain/i.test(hitFeedback.centeredText || "")) {
        errors.push(`timing or chain leaked into centered judgement: ${JSON.stringify(hitFeedback)}`);
      }
      if (!/ms/.test(hitFeedback.metaText || "") || hitFeedback.metaPosition?.top > 80 || hitFeedback.metaPosition?.right > 80) {
        errors.push(`timing feedback was not placed at top-right: ${JSON.stringify(hitFeedback)}`);
      }
      await page
        .waitForFunction(() => document.querySelector('.judgement-label[data-sprite="miss"]'), { timeout: 1000 })
        .catch(() => null);
      hitFeedback.missPalette = await page.evaluate(() => {
        const image = document.querySelector('.judgement-label[data-sprite="miss"] .judgement-sprite-color');
        if (!image?.naturalWidth) return null;
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let colored = 0;
        let redDominant = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 3] < 96) continue;
          const red = data[index];
          const green = data[index + 1];
          const blue = data[index + 2];
          if (Math.max(red, green, blue) - Math.min(red, green, blue) < 18) continue;
          colored += 1;
          if (red > green * 1.4 && red > blue * 1.25) redDominant += 1;
        }
        return { colored, redRatio: colored ? redDominant / colored : 0 };
      });
      await page.evaluate(() => {
        const whiteFlash = document.querySelector(
          '.judgement-label[data-sprite="miss"] .judgement-sprite-white-flash',
        );
        if (whiteFlash) whiteFlash.style.visibility = "hidden";
      });
      await page.screenshot({ path: path.join(artifactDirectory, "desktop-miss-red.png"), fullPage: false });
      if (!hitFeedback.missPalette || hitFeedback.missPalette.redRatio < 0.45) {
        errors.push(`MISS judgement did not use a red palette: ${JSON.stringify(hitFeedback)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
      const persistentFeedback = await page.evaluate(() => ({
        text: document.getElementById("effectCombo")?.textContent,
        visible: document.getElementById("effectCombo")?.dataset.visible,
        combo: document.getElementById("comboValue")?.textContent,
      }));
      hitFeedback.persistentFeedback = persistentFeedback;
      if (
        (persistentFeedback.combo !== "000" &&
          (persistentFeedback.visible !== "true" || !persistentFeedback.text)) ||
        (persistentFeedback.combo === "000" &&
          (persistentFeedback.visible !== "false" || persistentFeedback.text))
      ) {
        errors.push(`top-right feedback did not follow combo state: ${JSON.stringify(persistentFeedback)}`);
      }
      const allowedHitFrame = Math.max(50, hitFeedback.frameTiming.baselineMax + 25);
      if (hitFeedback.frameTiming.hitMax > allowedHitFrame) {
        errors.push(`hit feedback caused a frame hitch: ${JSON.stringify(hitFeedback.frameTiming)}`);
      }

      await page.click("#backButton");
      await page.waitForFunction(
        () => !document.getElementById("selectionView")?.hidden && document.getElementById("gameView")?.hidden,
        { timeout: 2000 },
      );

      const midiInput = await page.$("#midiFileInput");
      await midiInput.uploadFile(path.resolve("output", "neon_velocity_edm.mid"));
      await page.waitForFunction(
        () =>
          document.getElementById("fileName")?.textContent === "neon_velocity_edm.mid" &&
          document.getElementById("selectionNotes")?.textContent === "220" &&
          document.getElementById("stateText")?.textContent.includes("채보 준비 완료"),
        { timeout: 10000 },
      );

      const warmPadValue = await page.$eval("#trackSelect", (select) =>
        [...select.options].find((option) => option.textContent.includes("Warm Pad"))?.value,
      );
      if (!warmPadValue) {
        errors.push("Warm Pad track was not available for hold validation");
      } else {
        await page.select("#trackSelect", warmPadValue);
        await page.waitForFunction(
          () => document.getElementById("stageMessageTitle")?.textContent.includes("96 HOLDS"),
          { timeout: 3000 },
        );
        await page.click("#enterGameButton");
        await page.waitForFunction(
          () => document.getElementById("stateText")?.textContent.includes("플레이 중"),
          { timeout: 7000 },
        );
        const holdStartedAt = await page.evaluate(() => performance.now());
        await page.keyboard.down("f");
        await page.keyboard.down("j");
        await page.waitForFunction(
          () => document.getElementById("judgement")?.textContent === "Hold",
          { timeout: 1000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 350));
        const holdingState = await page.evaluate(() => ({
          judgement: document.getElementById("judgement")?.textContent,
          laneF: document.querySelector('[data-lane="1"]')?.dataset.holding,
          laneJ: document.querySelector('[data-lane="2"]')?.dataset.holding,
          score: document.getElementById("scoreValue")?.textContent,
          combo: document.getElementById("comboValue")?.textContent,
        }));
        await page.screenshot({ path: path.join(artifactDirectory, "desktop-hold.png"), fullPage: false });
        const remainingHoldTime = await page.evaluate(
          (startedAt) => Math.max(0, 1340 - (performance.now() - startedAt)),
          holdStartedAt,
        );
        await new Promise((resolve) => setTimeout(resolve, remainingHoldTime));
        await page.keyboard.up("f");
        await page.keyboard.up("j");
        await page.waitForFunction(
          () =>
            document.querySelector('[data-lane="1"]')?.dataset.holding === "false" &&
            document.querySelector('[data-lane="2"]')?.dataset.holding === "false",
          { timeout: 1000 },
        );
        const releasedState = await page.evaluate(() => {
          const marker = document.querySelector(".hit-confirmation");
          return {
            judgement: document.getElementById("judgement")?.textContent,
            laneF: document.querySelector('[data-lane="1"]')?.dataset.holding,
            laneJ: document.querySelector('[data-lane="2"]')?.dataset.holding,
            score: document.getElementById("scoreValue")?.textContent,
            combo: document.getElementById("comboValue")?.textContent,
            metaText: document.getElementById("effectCombo")?.textContent,
            markerPositionSource: marker?.dataset.positionSource,
          };
        });
        holdFeedback = { holdingState, releasedState, earlyReleaseState: null };
        if (holdingState.laneF !== "true" || holdingState.laneJ !== "true") {
          errors.push(`hold lanes did not enter active state: ${JSON.stringify(holdingState)}`);
        }
        if (holdingState.score !== "000000" || holdingState.combo !== "000") {
          errors.push(`hold was scored before release: ${JSON.stringify(holdingState)}`);
        }
        if (releasedState.laneF !== "false" || releasedState.laneJ !== "false") {
          errors.push(`hold lanes did not release: ${JSON.stringify(releasedState)}`);
        }
        if (!/^Hold (perfect!|great|good)/.test(releasedState.judgement) || releasedState.combo !== "002") {
          errors.push(`hold release was not judged correctly: ${JSON.stringify(releasedState)}`);
        }
        if (!/2 chain/.test(releasedState.metaText || "")) {
          errors.push(`hold combo was not shown in top-right feedback: ${JSON.stringify(releasedState)}`);
        }

        await page.keyboard.press("Enter");
        await page.waitForFunction(
          () => document.getElementById("stateText")?.textContent.includes("플레이 중"),
          { timeout: 7000 },
        );
        await page.keyboard.down("f");
        await page.waitForFunction(
          () => document.getElementById("judgement")?.textContent === "Hold",
          { timeout: 1000 },
        );
        const shakeCountBeforeEarlyRelease = await page.$eval(
          "#gameCanvas",
          (canvas) => Number(canvas.dataset.hitShakeCount || 0),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        await page.keyboard.up("f");
        await page.waitForFunction(
          () => document.getElementById("judgement")?.textContent.startsWith("Hold break"),
          { timeout: 1000 },
        );
        holdFeedback.earlyReleaseState = await page.evaluate(() => ({
          judgement: document.getElementById("judgement")?.textContent,
          laneF: document.querySelector('[data-lane="1"]')?.dataset.holding,
          combo: document.getElementById("comboValue")?.textContent,
          metaText: document.getElementById("effectCombo")?.textContent,
          metaVisible: document.getElementById("effectCombo")?.dataset.visible,
          latestLog: document.querySelector("#eventLog li span")?.textContent,
          hitShakeCount: Number(document.getElementById("gameCanvas")?.dataset.hitShakeCount || 0),
          missFlashCount: Number(document.getElementById("missFlash")?.dataset.flashCount || 0),
          missFlashVisible: document.getElementById("missFlash")?.dataset.visible,
          missFlashDuration: Number(document.getElementById("missFlash")?.dataset.flashDuration || 0),
          missFlashRect: (() => {
            const rect = document.getElementById("missFlash")?.getBoundingClientRect();
            return rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null;
          })(),
        }));
        await new Promise((resolve) => setTimeout(resolve, 260));
        holdFeedback.earlyReleaseState.missFlashSustained = await page.evaluate(() => ({
          visible: document.getElementById("missFlash")?.dataset.visible,
          opacity: Number.parseFloat(getComputedStyle(document.getElementById("missFlash")).opacity),
        }));
        await page.screenshot({ path: path.join(artifactDirectory, "desktop-miss.png"), fullPage: false });
        if (
          holdFeedback.earlyReleaseState.laneF !== "false" ||
          holdFeedback.earlyReleaseState.combo !== "000" ||
          holdFeedback.earlyReleaseState.metaVisible !== "false" ||
          holdFeedback.earlyReleaseState.metaText ||
          holdFeedback.earlyReleaseState.hitShakeCount !== shakeCountBeforeEarlyRelease ||
          holdFeedback.earlyReleaseState.missFlashCount < 1 ||
          holdFeedback.earlyReleaseState.missFlashVisible !== "true" ||
          holdFeedback.earlyReleaseState.missFlashDuration < 500 ||
          holdFeedback.earlyReleaseState.missFlashSustained.visible !== "true" ||
          holdFeedback.earlyReleaseState.missFlashSustained.opacity < 0.2 ||
          holdFeedback.earlyReleaseState.missFlashRect?.width !== viewport.width ||
          holdFeedback.earlyReleaseState.missFlashRect?.height !== viewport.height ||
          !holdFeedback.earlyReleaseState.latestLog.includes("EARLY RELEASE")
        ) {
          errors.push(`early hold release was not broken correctly: ${JSON.stringify(holdFeedback.earlyReleaseState)}`);
        }

        await page.click("#backButton");
        await page.waitForFunction(
          () => !document.getElementById("selectionView")?.hidden && document.getElementById("gameView")?.hidden,
          { timeout: 2000 },
        );
      }
    } else {
      await page.click("#backButton");
      await page.waitForFunction(
        () => !document.getElementById("selectionView")?.hidden && document.getElementById("gameView")?.hidden,
        { timeout: 2000 },
      );
    }

    reports.push({
      viewport: viewport.name,
      ...metrics,
      gameLayout,
      liveTunnelSpeed,
      hitFeedback,
      holdFeedback,
      errors,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify(reports, null, 2));
if (reports.some((report) => report.errors.length)) process.exit(1);
