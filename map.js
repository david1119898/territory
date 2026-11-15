// map.js — общая карта мира. Её используют и сервер, и браузер,
// поэтому территории и соседства у всех совпадают.
(function (root) {
  const W = 1000, H = 560, CELL = 2;

  // Материки/острова: многоугольники + "города" (центры территорий).
  // Каждая клетка суши достаётся ближайшему городу своего материка.
  const LANDS = [
    { // Северная Америка
      polys: [
        [[60,70],[150,50],[260,60],[300,90],[290,150],[260,200],[240,240],[200,250],[170,220],[130,190],[90,150],[60,110]],
        [[200,245],[245,240],[255,275],[232,292],[212,276]],
      ],
      towns: [['Аляска',100,95],['Западная Канада',175,100],['Восточная Канада',260,105],
              ['Запад США',150,170],['Восток США',245,175],['Мексика',215,258]],
    },
    { polys: [[[335,35],[395,30],[405,75],[365,105],[335,78]]], towns: [['Гренландия',368,65]] },
    { // Южная Америка
      polys: [[[240,305],[300,292],[342,322],[352,372],[322,432],[292,502],[266,512],[260,442],[240,372]]],
      towns: [['Колумбия',275,320],['Бразилия',315,375],['Перу',268,385],['Аргентина',285,465]],
    },
    { polys: [[[418,80],[446,74],[448,116],[426,122]]], towns: [['Британия',433,98]] },
    { // Европа
      polys: [[[460,70],[520,58],[568,80],[566,135],[528,162],[472,166],[456,135]]],
      towns: [['Скандинавия',500,88],['Германия',500,128],['Иберия',475,150],
              ['Восточная Европа',548,104],['Балканы',535,150]],
    },
    { // Африка
      polys: [[[450,182],[530,172],[582,202],[602,262],[582,342],[552,422],[512,442],[482,382],[462,302],[442,232]]],
      towns: [['Сахара',490,220],['Египет',560,215],['Западная Африка',465,285],
              ['Конго',525,320],['Восточная Африка',575,290],['ЮАР',530,400]],
    },
    { // Азия
      polys: [
        [[565,60],[700,40],[850,50],[925,90],[905,160],[845,212],[782,262],[722,272],[662,232],[622,202],[585,172],[565,122]],
        [[690,250],[762,262],[732,352],[702,332]],
      ],
      towns: [['Урал',625,95],['Сибирь',715,80],['Якутия',815,85],['Камчатка',885,110],
              ['Монголия',775,145],['Китай',770,200],['Ближний Восток',630,190],
              ['Казахстан',660,140],['Индия',725,300],['Индокитай',835,200]],
    },
    { polys: [[[935,125],[958,120],[965,175],[945,190]]], towns: [['Япония',950,155]] },
    { polys: [[[790,305],[880,312],[905,352],[825,355]]], towns: [['Индонезия',850,330]] },
    { polys: [[[822,392],[922,382],[955,432],[925,482],[855,492],[812,452]]],
      towns: [['Западная Австралия',860,440],['Восточная Австралия',920,435]] },
  ];

  // Морские пути (где суша не соприкасается)
  const SEA_LINKS = [
    ['Аляска','Камчатка'],['Гренландия','Восточная Канада'],['Британия','Германия'],
    ['Британия','Скандинавия'],['Мексика','Колумбия'],['Бразилия','Западная Африка'],
    ['Иберия','Сахара'],['Балканы','Египет'],['Египет','Ближний Восток'],
    ['Япония','Камчатка'],['Япония','Индокитай'],['Индонезия','Индокитай'],
    ['Индонезия','Индия'],['Индонезия','Западная Австралия'],['Индонезия','Восточная Австралия'],
  ];

  function hash2(ix, iy) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  function inPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function buildMap() {
    const GW = W / CELL, GH = H / CELL;
    const towns = [];
    LANDS.forEach((L, li) => L.towns.forEach(t => towns.push({ name: t[0], tx: t[1], ty: t[2], land: li })));
    const landTowns = LANDS.map(() => []);
    towns.forEach((t, i) => landTowns[t.land].push(i));

    const cells = new Int16Array(GW * GH).fill(-1);
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const x = (gx + 0.5) * CELL, y = (gy + 0.5) * CELL;
        // "рисованная" неровность берегов и границ
        const wx = x + (vnoise(x / 45, y / 45) - 0.5) * 16 + (vnoise(x / 14, y / 14) - 0.5) * 5;
        const wy = y + (vnoise(x / 45 + 100, y / 45 + 100) - 0.5) * 16 + (vnoise(x / 14 + 50, y / 14 + 50) - 0.5) * 5;
        let land = -1;
        for (let li = 0; li < LANDS.length && land < 0; li++) {
          for (const p of LANDS[li].polys) if (inPoly(wx, wy, p)) { land = li; break; }
        }
        if (land < 0) continue;
        let best = -1, bd = Infinity;
        for (const ti of landTowns[land]) {
          const dx = wx - towns[ti].tx, dy = wy - towns[ti].ty;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = ti; }
        }
        cells[gy * GW + gx] = best;
      }
    }

    // соседство по общим границам
    const adjSets = towns.map(() => new Set());
    const link = (a, b) => { if (a >= 0 && b >= 0 && a !== b) { adjSets[a].add(b); adjSets[b].add(a); } };
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const a = cells[gy * GW + gx];
        if (gx + 1 < GW) link(a, cells[gy * GW + gx + 1]);
        if (gy + 1 < GH) link(a, cells[(gy + 1) * GW + gx]);
      }
    }
    const byName = new Map(towns.map((t, i) => [t.name, i]));
    const seaLinks = [];
    for (const [an, bn] of SEA_LINKS) {
      const a = byName.get(an), b = byName.get(bn);
      if (a === undefined || b === undefined) throw new Error('Нет территории для морского пути: ' + an + ' — ' + bn);
      if (!adjSets[a].has(b)) seaLinks.push([a, b]);
      link(a, b);
    }

    // центр территории — клетка территории, ближайшая к центру тяжести
    const sx = new Float64Array(towns.length), sy = new Float64Array(towns.length), cnt = new Int32Array(towns.length);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const t = cells[gy * GW + gx];
      if (t >= 0) { sx[t] += gx; sy[t] += gy; cnt[t]++; }
    }
    const cx = new Float64Array(towns.length), cy = new Float64Array(towns.length), cd = new Float64Array(towns.length).fill(Infinity);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const t = cells[gy * GW + gx];
      if (t < 0 || !cnt[t]) continue;
      const dx = gx - sx[t] / cnt[t], dy = gy - sy[t] / cnt[t];
      const d = dx * dx + dy * dy;
      if (d < cd[t]) { cd[t] = d; cx[t] = (gx + 0.5) * CELL; cy[t] = (gy + 0.5) * CELL; }
    }

    const territories = towns.map((t, i) => ({
      id: i, name: t.name, x: cnt[i] ? cx[i] : t.tx, y: cnt[i] ? cy[i] : t.ty,
      cells: cnt[i], adj: Array.from(adjSets[i]).sort((a, b) => a - b),
    }));
    return { W, H, CELL, GW, GH, cells, territories, seaLinks };
  }

  const api = { buildMap, hash2, vnoise };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GameMap = api;
})(typeof self !== 'undefined' ? self : this);
