/**
 * Headless check of the Character and Animations tabs: saved poses, animations and looks,
 * moving the item with the hand following, item placement and limits (no window is opened).
 *
 *   npm run build && node scripts/ux-check.mjs
 *
 * Serves the built site itself. To check a server that is already running, pass its
 * address: node scripts/ux-check.mjs http://localhost:5173/
 * Screenshots go to test-output/ux-*.png.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const OUT = 'test-output';
mkdirSync(OUT, { recursive: true });
const server = process.argv[2] ? null : await preview({ preview: { port: 4180, strictPort: true, host: '127.0.0.1' } });
const base = process.argv[2] ?? 'http://127.0.0.1:4180/';
const browser = await chromium.launch({
  channel: process.env.E2E_CHANNEL ?? 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
let failed = false;
const problems = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed = true;
};

try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 860 }, acceptDownloads: true })).newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(base);
  await page.waitForSelector('[role=tab]');
  const H = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, ms = 60000) => page.waitForFunction(fn, null, { timeout: ms, polling: 100 });
  const shot = (name) => page.screenshot({ path: `${OUT}/ux-${name}.png` });
  const tab = (name) => page.getByRole('tab', { name }).click();
  const tabText = () => H(() => document.querySelector('.tab-page')?.innerText ?? '');

  // Character tab, nothing loaded
  await tab('Character');
  check(/Load a whole character/.test(await tabText()), 'Character tab explains what to load');

  // the sample player: the tab offers the hands
  await page.getByRole('button', { name: 'Use the sample player' }).click();
  await until(() => !window.__handhold.ui.handBusy);
  const picks = await page.locator('.tab-page .seg button').allInnerTexts();
  check(picks.length === 2, 'Character tab offers both hands', picks.join(', '));
  await page.locator('.tab-page .seg button', { hasText: 'Right' }).click();
  await until(() => !window.__handhold.ui.handBusy && !!window.__handhold.hand);
  await page.waitForTimeout(400);
  const text = await tabText();
  check(/Right hand/.test(text) && /Soft ends/i.test(text), 'Character tab shows the hand, arm limits and soft ends');
  await shot('character');

  // Grip tab: the hammer, found grips, one/two hands
  await tab('Grip');
  await H(() => window.__handhold.actions.objectSample('hammer'));
  await H(() => window.__handhold.solve());
  await until(() => (window.__handhold.grasps?.length ?? 0) > 0, 180000);
  await H(() => window.__handhold.actions.openStep(3));
  await page.waitForTimeout(200);
  const seg = await page.locator('.seg button').allInnerTexts();
  await H(() => window.__handhold.actions.openStep(4));
  check(seg.some((t) => /One hand/.test(t)) && seg.some((t) => /Both hands/.test(t)), 'Grip step has a one hand / both hands choice', seg.join(' | '));

  // Item move: a slide slider moves the wrist, letting go closes the fingers again
  const before = await H(() => window.__handhold.grasps[window.__handhold.ui.selected].wrist.elements.slice());
  await H(() => window.__handhold.actions.nudgeItem(0, 15, true));
  await until(() => !window.__handhold.ui.nudging, 120000);
  const after = await H(() => window.__handhold.grasps[window.__handhold.ui.selected].wrist.elements.slice());
  const moved = Math.hypot(after[12] - before[12], after[13] - before[13], after[14] - before[14]);
  check(moved > 1e-4, 'Moving the item in the hand moves the grip', `wrist moved ${moved.toFixed(4)}`);
  await H(() => window.__handhold.actions.resetNudge());
  await until(() => !window.__handhold.ui.nudging, 120000);
  const back = await H(() => window.__handhold.grasps[window.__handhold.ui.selected].wrist.elements.slice());
  check(Math.hypot(back[12] - before[12], back[13] - before[13], back[14] - before[14]) < 1e-6, 'Reset puts the item back');

  // Object turn sliders
  await H(() => window.__handhold.actions.setObjectAngle(2, 30));
  check((await H(() => window.__handhold.ui.objectAngles[2])) === 30, 'Turning the item exactly sets its angle');
  await H(() => window.__handhold.actions.setObjectAngle(2, 0));
  check(await H(() => !!window.__handhold.ui.grip), 'The grip point stays marked when the item is turned');
  if (!(await H(() => window.__handhold.grasps?.length))) {
    // turning the item clears the grips: find them again
    await H(() => window.__handhold.solve());
    await until(() => (window.__handhold.grasps?.length ?? 0) > 0, 180000);
  }

  // Character tab with grips: the whole body, limits change the arm
  await tab('Character');
  await page.waitForTimeout(500);
  check(await H(() => window.__handhold.characterView), 'Character tab shows the whole character holding it');
  // the free (left) hand hangs by the hip, below the shoulders
  const freeHand = await H(() => {
    const f = window.__handhold.hand?.free;
    const h = f?.fore.children.find((c) => c.isBone);
    if (!h) return null;
    h.updateWorldMatrix(true, false);
    f.upper.updateWorldMatrix(true, false);
    return { hand: h.matrixWorld.elements[13], shoulder: f.upper.matrixWorld.elements[13] };
  });
  check(!!freeHand && freeHand.hand < freeHand.shoulder - 0.3, 'The free arm hangs at the side', freeHand ? `hand ${freeHand.hand.toFixed(2)} m, shoulder ${freeHand.shoulder.toFixed(2)} m` : 'no free arm found');
  await shot('character-hold');
  const elbow = () => H(() => { const f = window.__handhold.hand?.arm?.fore; if (!f) return null; f.updateWorldMatrix(true, false); const e = f.matrixWorld.elements; return [e[12], e[13], e[14]]; });
  const e0 = await elbow();
  await H(() => window.__handhold.actions.setBodyLimit('elbowOut', 45, true));
  await page.waitForTimeout(200);
  const e1 = await elbow();
  check(!!(e0 && e1) && Math.hypot(e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]) > 1e-5, 'Arm limit sliders move the arm', e0 && e1 ? `elbow moved ${Math.hypot(e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]).toFixed(4)}` : 'no elbow');
  await H(() => window.__handhold.actions.resetBodyLimits());

  // finger limits
  await H(() => window.__handhold.actions.setFingerLimit(1, 0, -5, 60));
  check(await H(() => window.__handhold.ui.limitsChanged), 'Changing a finger limit asks to find grips again');
  await H(() => window.__handhold.actions.resetFingerLimits());

  // Animations tab: nothing saved yet, and no Play tab any more
  check((await page.getByRole('tab', { name: 'Play' }).count()) === 0, 'There is no Play tab');
  await tab('Animations');
  check((await tabText()).includes('Nothing saved yet'), 'Animations starts with nothing saved');
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const centre = () => H(() => window.__handhold.itemCentre());
  const wrist = () => H(() => window.__handhold.arm.hold.position.toArray());
  const savedNow = () => H(() => window.__handhold.saved);

  // 1. a still pose, shown as soon as it is added
  await page.locator('[data-key="add-pose"]').click();
  await page.waitForTimeout(300);
  check((await savedNow()).length === 1 && (await savedNow())[0].kind === 'pose' && /a still pose/.test(await tabText()), 'Add a pose saves a still pose and shows it', JSON.stringify(await savedNow()));
  await shot('anim-pose');

  // moving the item: the handle sits on the item, and the hand goes with it
  await page.locator('[data-key="saved-gizmo-item"]').click();
  const c0 = await centre();
  const w0 = await wrist();
  const want = [c0[0] + 0.04, c0[1] + 0.09, c0[2] + 0.03];
  await H((p) => window.__handhold.moveHandle(p), want);
  const c1 = await centre();
  const w1 = await wrist();
  check(dist(c1, want) < 0.004 && Math.abs(dist(w1, w0) - dist(c1, c0)) < 0.004, 'Dragging the item moves it there and the hand goes with it', `item ${(dist(c1, c0) * 100).toFixed(1)} cm, wrist ${(dist(w1, w0) * 100).toFixed(1)} cm, ${(dist(c1, want) * 1000).toFixed(1)} mm from the target`);
  await shot('anim-item-moved');
  // turning it on the spot: the item stays, the hand travels round it
  await H(() => window.__handhold.actions.setTurn(1, 35));
  const c2 = await centre();
  const w2 = await wrist();
  check(dist(c2, c1) < 0.005 && dist(w2, w1) > 0.01, 'With the handle on the item, turning keeps the item in place and moves the hand', `item ${(dist(c2, c1) * 1000).toFixed(1)} mm, wrist ${(dist(w2, w1) * 100).toFixed(1)} cm`);
  // the other way round: the hand stays, the item swings about the wrist
  await page.locator('[data-key="saved-gizmo-hand"]').click();
  await H(() => window.__handhold.actions.setTurn(1, 0));
  const c3 = await centre();
  const w3 = await wrist();
  check(dist(w3, w2) < 1e-6 && dist(c3, c2) > 0.01, 'With the handle on the hand, turning keeps the wrist in place and swings the item', `wrist ${(dist(w3, w2) * 1000).toFixed(2)} mm, item ${(dist(c3, c2) * 100).toFixed(1)} cm`);

  // 2. an animation that plays
  await page.locator('[data-key="item-style-weapon"]').click();
  await page.locator('[data-key="motion-use"]').click();
  await page.waitForTimeout(200);
  let list = await savedNow();
  check(list.length === 2 && list[1].kind === 'clip' && list[1].seconds > 0.3 && /an animation/.test(await tabText()), 'A ready-made movement is saved as an animation and shown', JSON.stringify(list[1]));
  check(await H(() => window.__handhold.ui.clipPlaying), 'It starts playing');
  const t0 = await H(() => window.__handhold.ui.clipTime);
  await page.waitForTimeout(500);
  await page.locator('[data-key="clip-play"]').click();
  const t1 = await H(() => window.__handhold.ui.clipTime);
  check(!(await H(() => window.__handhold.ui.clipPlaying)), 'Pause stops it', `time went ${t0.toFixed(2)} -> ${t1.toFixed(2)} s`);
  const atStart = await H(() => (window.__handhold.actions.clipSeek(0), window.__handhold.itemCentre()));
  const atMiddle = await H((s) => (window.__handhold.actions.clipSeek(s), window.__handhold.itemCentre()), list[1].seconds * 0.45);
  check(dist(atStart, atMiddle) > 0.005, 'Scrubbing the time line moves the item', `${(dist(atStart, atMiddle) * 100).toFixed(1)} cm between the start and the middle`);
  await shot('anim-clip');
  await page.locator('[data-key="motion-walk"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-key="clip-play"]').click();

  // 3. a look: the arm follows the player's view
  await page.locator('[data-key="add-look"]').click();
  await page.waitForTimeout(300);
  list = await savedNow();
  check(list.length === 4 && list[3].kind === 'look' && /follows the player/.test(await tabText()), 'Add a look saves one and shows it', list.map((x) => `${x.kind} ${x.name}`).join(', '));
  const look = (yaw, pitch) => H(([y, p]) => (window.__handhold.actions.lookAim(y, p, true), window.__handhold.itemCentre()), [yaw, pitch]);
  // the player's right, from the way the character faces
  const right = await H(() => {
    const a = window.__handhold.hand.arm;
    return a.forward.clone().cross(a.forward.clone().set(0, 1, 0)).normalize().toArray();
  });
  const along = (p, q) => (p[0] - q[0]) * right[0] + (p[1] - q[1]) * right[1] + (p[2] - q[2]) * right[2];
  const ahead = await look(0, 0);
  const up = await look(0, 40);
  await shot('anim-look-up');
  const down = await look(0, -30);
  await shot('anim-look-down');
  const toRight = await look(40, 0);
  await shot('anim-look-right');
  const toLeft = await look(-40, 0);
  check(up[1] - ahead[1] > 0.05 && ahead[1] - down[1] > 0.05, 'Looking up lifts the item and looking down lowers it', `+${((up[1] - ahead[1]) * 100).toFixed(1)} cm, -${((ahead[1] - down[1]) * 100).toFixed(1)} cm`);
  check(along(toRight, ahead) > 0.05 && along(toLeft, ahead) < -0.05, 'Looking right and left swings it to that side', `${(along(toRight, ahead) * 100).toFixed(1)} cm, ${(along(toLeft, ahead) * 100).toFixed(1)} cm`);
  // the square: pressing near its top looks up
  const pad = page.locator('[data-key="look-pad"]');
  await pad.scrollIntoViewIfNeeded();
  const square = await pad.boundingBox();
  await page.mouse.click(square.x + square.width / 2, square.y + 4);
  const aim = await H(() => window.__handhold.ui.lookAim);
  check(aim[0] === 0 && aim[1] > 30, 'Pressing the top of the square looks up', JSON.stringify(aim));
  await page.locator('[data-key="look-centre"]').click();
  check((await H(() => window.__handhold.ui.lookAim)).every((v) => v === 0) && dist(await centre(), ahead) < 1e-4, 'Straight ahead brings it back');
  await shot('anim-look');

  // the export step lists them, and every file carries them
  await tab('Grip');
  await page.locator('.step-head', { hasText: 'Export' }).click();
  const manifest = await page.locator('.manifest').innerText();
  check(manifest.includes('Saved animations (4)') && list.every((x) => manifest.includes(`"${x.name}"`)), 'Export lists what is saved', manifest.replace(/\n/g, ' | '));
  await shot('export-manifest');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.locator('[data-key="dl-glb"]').click()]);
  const glbPath = `${OUT}/ux-saved.glb`;
  await dl.saveAs(glbPath);
  const glb = readFileSync(glbPath);
  const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const anims = (gltf.animations ?? []).map((a) => a.name);
  const wanted = ['Grip', ...list.filter((x) => x.kind !== 'look').map((x) => x.name), ...list.filter((x) => x.kind === 'look').flatMap((x) => [`${x.name} Down-Up`, `${x.name} Left-Right`])];
  check(wanted.every((n) => anims.includes(n)), 'The GLB has the Grip animation and one for everything saved', anims.join(', '));
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.locator('[data-key="dl-json"]').click()]);
  await dl2.saveAs(`${OUT}/ux-saved.pose.json`);
  const arm = JSON.parse(readFileSync(`${OUT}/ux-saved.pose.json`, 'utf8')).arm;
  const grid = arm.looks?.[0];
  check(
    arm.poses?.length === 1 && arm.clips?.length === 2 && arm.clips[1].loops === true && arm.looks?.length === 1 && grid.grid.length === grid.columns * grid.rows && arm.forward?.length === 3,
    'The pose file has the pose, both animations and the look as a grid',
    `poses ${arm.poses?.length}, animations ${arm.clips?.map((c) => `${c.name}${c.loops ? ' (loops)' : ''}`).join(', ')}, look ${grid?.columns}x${grid?.rows} yaw ${grid?.yaw} pitch ${grid?.pitch}`,
  );
  // after an export, the next steps say how to use what was saved
  await page.locator('[data-key="export-unity"]').click();
  await page.waitForSelector('.howto', { timeout: 120000 });
  check((await page.locator('.howto').innerText()).includes('.Show("'), 'The Unity steps show how to play a saved item by name', (await page.locator('.howto li').last().innerText()).slice(0, 110));
  check(problems.length === 0, 'No page errors', problems.slice(0, 3).join(' / '));
} catch (e) {
  check(false, 'run', e.message.split('\n').slice(0, 4).join(' | '));
  console.log(problems.slice(0, 5).join('\n'));
} finally {
  await browser.close();
  await server?.close();
}
process.exit(failed ? 1 : 0);
