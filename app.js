/* 茗溪学園IB 夜の英語練習帳 — flashcard / review / quiz app
   Reads vocab_app.json (via window.VOCAB_DATA fallback so it also works offline). */
(function () {
  "use strict";

  var DATA = null;
  var byDay = {};
  var glossaryMap = {};
  var baseItems = [];
  var TOTAL = 0;

  var STORAGE_KEY = "vocab_app_progress_v1";
  var VOICE_KEY = "vocab_app_voice_v1";
  var state = {
    day: 1,
    view: "study",
    progress: { completed: {}, quiz: {} },
    quiz: null,
    voice: true
  };

  /* ---------- utils ---------- */
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededShuffle(arr, seed) {
    var rnd = mulberry32(seed);
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- speech (tap-to-listen) ---------- */
  function speechSupported() {
    return typeof window !== "undefined" && "speechSynthesis" in window &&
      typeof window.SpeechSynthesisUtterance === "function";
  }
  function loadVoice() {
    try { var v = localStorage.getItem(VOICE_KEY); state.voice = v == null ? true : v === "1"; }
    catch (e) { state.voice = true; }
  }
  function saveVoice() {
    try { localStorage.setItem(VOICE_KEY, state.voice ? "1" : "0"); } catch (e) {}
  }
  function pickVoice(lang) {
    if (!speechSupported()) return null;
    var vs = window.speechSynthesis.getVoices() || [];
    if (!vs.length) return null;
    var want = (lang || "en-US").toLowerCase();
    var norm = function (l) { return String(l || "").replace("_", "-").toLowerCase(); };
    var exact = vs.filter(function (v) { return norm(v.lang) === want; });
    var prefer = /Samantha|Google US English|Google UK English|Ava|Allison|Alex|Serena|Daniel|Karen|Moira/i;
    if (exact.length) return exact.filter(function (v) { return prefer.test(v.name); })[0] || exact[0];
    var en = vs.filter(function (v) { return /^en/i.test(v.lang); });
    return en[0] || null;
  }
  function speak(text, lang) {
    if (!state.voice || !speechSupported() || !text) return;
    var synth = window.speechSynthesis;
    try { synth.cancel(); } catch (e) {}
    var u = new window.SpeechSynthesisUtterance(text);
    u.lang = lang || "en-US";
    u.rate = 0.92;
    u.pitch = 1;
    var v = pickVoice(u.lang);
    if (v) u.voice = v;
    setTimeout(function () { try { synth.speak(u); } catch (e) {} }, 0);
  }
  function speakable(tag, cls, text, lang) {
    var n = el(tag, cls + (speechSupported() ? " speakable" : ""));
    if (speechSupported()) n.appendChild(el("span", "spk-inline", "🔊"));
    n.appendChild(document.createTextNode((speechSupported() ? " " : "") + text));
    if (speechSupported()) {
      n.addEventListener("click", function (e) { e.stopPropagation(); speak(text, lang); });
    }
    return n;
  }

  /* ---------- data ---------- */
  function loadData() {
    if (window.VOCAB_DATA) { initData(window.VOCAB_DATA); return Promise.resolve(); }
    return fetch("vocab_app.json")
      .then(function (r) { return r.json(); })
      .then(initData)
      .catch(function () {
        document.getElementById("main").innerHTML =
          '<div class="card">vocab_app.json を読み込めませんでした。index.html と同じフォルダに置いてください。</div>';
      });
  }
  function initData(d) {
    DATA = d;
    byDay = {};
    (d.days || []).forEach(function (day) { byDay[day.day] = day; });
    glossaryMap = {};
    (d.glossary || []).forEach(function (g) { glossaryMap[g.word] = g; });
    baseItems = (d.base_bank && d.base_bank.items) || [];
    TOTAL = (d.days || []).length;
  }

  /* Fill ipa / katakana / meaning from glossary when a word object lacks them. */
  function enrich(v) {
    var g = glossaryMap[v.word] || {};
    return {
      word: v.word,
      ipa: v.ipa || g.ipa || "",
      katakana: v.katakana || g.katakana || "",
      meaning: v.meaning || g.meaning || "",
      days: g.days || null
    };
  }

  /* ---------- progress ---------- */
  function saveProgress() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress)); } catch (e) {}
  }
  function loadProgress() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state.progress = JSON.parse(raw);
    } catch (e) {}
    state.progress.completed = state.progress.completed || {};
    state.progress.quiz = state.progress.quiz || {};
  }

  /* ---------- review builder (study_loop.breakdown) ---------- */
  function pickBase(dayNum, n) {
    if (!baseItems.length) return [];
    var start = (((dayNum - 1) * n) % baseItems.length + baseItems.length) % baseItems.length;
    var out = [];
    for (var i = 0; i < n; i++) out.push(baseItems[(start + i) % baseItems.length]);
    return out;
  }
  function buildReview(dayNum) {
    var day = byDay[dayNum];
    var bd = (DATA.study_loop && DATA.study_loop.breakdown) || { new: 6, review_previous_day: 6, review_7_days_ago: 6, base_bank: 12 };
    var groups = [];
    var used = {};

    function addGroup(key, label, sub, words) {
      words.forEach(function (w) { used[w.word] = true; });
      groups.push({ key: key, label: label, sub: sub, words: words });
    }
    function dayWords(d, key, label, sub) {
      var src = byDay[d];
      if (!src) return null;
      return { key: key, label: label, sub: sub, words: src.vocabulary.map(enrich) };
    }

    addGroup("new", "新出", "今日の新出語", (day.vocabulary || []).map(enrich));

    var prev = dayWords(dayNum - 1, "prev", "前日", "前日の復習");
    var week = dayWords(dayNum - 7, "week", "7日前", "7日前の復習");

    var baseSel = pickBase(dayNum, bd.base_bank).map(enrich);
    baseSel.forEach(function (w) { used[w.word] = true; });

    function fill(words, need, label) {
      var out = words.slice();
      var pool = baseItems.filter(function (b) { return !used[b.word]; });
      var i = 0;
      while (out.length < need && pool.length) {
        var w = enrich(pool[i % pool.length]);
        if (!used[w.word]) { used[w.word] = true; out.push(w); }
        i++;
        if (i > pool.length * 2) break;
      }
      return { words: out, filled: out.length - words.length, label: label };
    }

    if (prev) addGroup("prev", prev.label, prev.sub, prev.words);
    else { var fp = fill([], bd.review_previous_day, "前日"); addGroup("prev", "前日", "（初日→基礎で補充）", fp.words); }

    if (week) addGroup("week", week.label, week.sub, week.words);
    else { var fw = fill([], bd.review_7_days_ago, "7日前"); addGroup("week", "7日前", "（序盤→基礎で補充）", fw.words); }

    addGroup("base", "基礎", "最初に覚える基礎語彙", baseSel);

    return { day: dayNum, groups: groups, total: groups.reduce(function (s, g) { return s + g.words.length; }, 0) };
  }

  /* ---------- quiz builder (check_30s -> 4-choice) ---------- */
  function buildQuiz(dayNum) {
    var day = byDay[dayNum];
    var all = (DATA.glossary || []).filter(function (g) { return g.word; });
    var questions = (day.vocabulary || []).map(function (v, i) {
      var correct = v.word;
      var correctMeaning = v.meaning || (glossaryMap[v.word] || {}).meaning || "";
      var cand = all.filter(function (g) {
        return g.word !== correct && (g.meaning || "") !== correctMeaning;
      });
      var distract = seededShuffle(cand, dayNum * 97 + i).slice(0, 3).map(function (g) { return g.word; });
      var options = seededShuffle([correct].concat(distract), dayNum * 131 + i);
      return {
        word: correct,
        meaning: correctMeaning,
        ipa: v.ipa || (glossaryMap[correct] || {}).ipa || "",
        options: options,
        correctIndex: options.indexOf(correct)
      };
    });
    return { day: dayNum, questions: questions, answers: {} };
  }

  /* ---------- rendering ---------- */
  function render() {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("is-active", t.dataset.view === state.view);
    });
    document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("is-active"); });
    document.getElementById("view-" + state.view).classList.add("is-active");

    var day = byDay[state.day];
    document.getElementById("dayNum").textContent = "Day " + state.day;
    document.getElementById("dayTopic").textContent = day ? day.topic : "—";
    document.getElementById("prevDay").disabled = state.day <= 1;
    document.getElementById("nextDay").disabled = state.day >= TOTAL;

    if (state.view === "study") renderStudy();
    else if (state.view === "review") renderReview();
    else if (state.view === "quiz") renderQuiz();
    else if (state.view === "base") renderBase();

    renderProgress();
  }

  function renderProgress() {
    var done = Object.keys(state.progress.completed).filter(function (k) { return state.progress.completed[k]; }).length;
    document.getElementById("progressBar").style.width = (done / TOTAL * 100) + "%";
    document.getElementById("progressLabel").textContent = done + " / " + TOTAL + " 日";
  }

  function flipCard(v) {
    var b = el("button", "flip");
    b.type = "button";
    var hint = speechSupported() ? "🔊 TAP" : "TAP";
    b.innerHTML =
      '<div class="flip__inner">' +
        '<div class="flip__face flip__face--front">' +
          '<div class="flip__word">' + esc(v.word) + "</div>" +
          (v.ipa ? '<div class="flip__ipa">/' + esc(v.ipa) + "/</div>" : "") +
          (v.katakana ? '<div class="flip__kata">' + esc(v.katakana) + "</div>" : "") +
          '<span class="flip__hint">' + hint + "</span>" +
        "</div>" +
        '<div class="flip__face flip__face--back">' +
          '<div class="flip__meaning">' + esc(v.meaning) + "</div>" +
          (v.katakana ? '<div class="flip__kata">' + esc(v.katakana) + "</div>" : "") +
          (v.days ? '<div class="flip__days">出現: Day ' + v.days.join(", ") + "</div>" : "") +
        "</div>" +
      "</div>";
    b.addEventListener("click", function () {
      b.classList.toggle("is-flipped");
      speak(v.word);
    });
    return b;
  }

  function renderStudy() {
    var host = document.getElementById("view-study");
    host.innerHTML = "";
    var day = byDay[state.day];
    if (!day) return;
    var isWM = day.type === "writing_model";

    if (isWM) {
      var hero = el("div", "hero");
      hero.appendChild(el("span", "daytag daytag--wm", "WRITING MODEL"));
      hero.appendChild(el("div", "hero__eyebrow", "Day " + day.day + " ・ " + esc(day.topic)));
      hero.appendChild(speakable("p", "hero__sentence", day.sentence.en));
      hero.appendChild(el("p", "hero__ja", esc(day.sentence.ja)));
      var g = el("div", "hero__grammar");
      g.appendChild(el("span", "grammar__label", "GRAMMAR / MODEL"));
      g.appendChild(el("div", null, esc(day.sentence.grammar_note)));
      hero.appendChild(g);
      var task = (DATA.study_loop && DATA.study_loop.sentence_task) || "";
      hero.appendChild(el("p", "hero__task", "<b>音読タスク</b>　" + esc(task)));
      host.appendChild(hero);
    } else {
      var card = el("div", "card");
      card.appendChild(el("span", "daytag daytag--rg", "READING / GRAMMAR"));
      card.appendChild(el("p", "study-day", "DAY " + day.day));
      card.appendChild(el("h2", "study-topic", esc(day.topic)));
      var sen = el("div", "sentence");
      sen.appendChild(speakable("div", "sentence__en", day.sentence.en));
      sen.appendChild(el("div", "sentence__ja", esc(day.sentence.ja)));
      card.appendChild(sen);
      var gr = el("div", "grammar");
      gr.appendChild(el("span", "grammar__label", "GRAMMAR NOTE"));
      gr.appendChild(el("div", null, esc(day.sentence.grammar_note)));
      card.appendChild(gr);
      host.appendChild(card);
    }

    /* vocabulary */
    var st = el("div", "section-title");
    st.appendChild(el("h2", null, "新出語彙"));
    st.appendChild(el("span", null, day.vocabulary.length + " 語 ・ タップで意味"));
    host.appendChild(st);
    var grid = el("div", "flipgrid");
    day.vocabulary.forEach(function (v) { grid.appendChild(flipCard(enrich(v))); });
    host.appendChild(grid);

    /* check_30s -> quiz entry */
    var ct = el("div", "section-title");
    ct.appendChild(el("h2", null, "30秒チェック"));
    ct.appendChild(el("span", null, "4択クイズ"));
    host.appendChild(ct);
    var ccard = el("div", "card");
    (day.check_30s || []).forEach(function (t) {
      var row = el("div", "revcard__meta");
      row.style.margin = "0 0 8px";
      row.innerHTML = "・" + esc(t);
      ccard.appendChild(row);
    });
    var row = el("div", "btn-row");
    var qbtn = el("button", "btn btn--primary", "クイズをはじめる →");
    qbtn.addEventListener("click", function () { state.view = "quiz"; state.quiz = null; render(); });
    var rbtn = el("button", "btn", "復習30語を見る");
    rbtn.addEventListener("click", function () { state.view = "review"; render(); });
    row.appendChild(qbtn); row.appendChild(rbtn);
    ccard.appendChild(row);
    host.appendChild(ccard);

    /* completion */
    var done = !!state.progress.completed[state.day];
    var foot = el("div", "btn-row");
    var dbtn = el("button", "btn " + (done ? "btn--ghost" : "btn--primary"), done ? "✓ 学習済み（解除）" : "この日を学習済みにする");
    dbtn.addEventListener("click", function () {
      if (state.progress.completed[state.day]) delete state.progress.completed[state.day];
      else state.progress.completed[state.day] = true;
      saveProgress(); render();
    });
    foot.appendChild(dbtn);
    host.appendChild(foot);
  }

  function renderReview() {
    var host = document.getElementById("view-review");
    host.innerHTML = "";
    var rv = buildReview(state.day);
    var bd = DATA.study_loop.breakdown;

    var head = el("div", "card");
    var top = el("div", "review-head");
    var h = el("div");
    h.innerHTML = '<div style="font-size:11px;letter-spacing:.12em;color:var(--muted)">DAY ' + state.day + " REVIEW</div>" +
      '<div style="font-size:20px;font-weight:800;margin-top:2px">今日の復習 <span style="color:var(--amber)">' + rv.total + '</span> 語</div>';
    top.appendChild(h);
    var ratio = el("div", "ratio");
    ratio.innerHTML =
      '<span class="ratio__chip"><b>' + bd.new + "</b> 新出</span>" +
      '<span class="ratio__chip"><b>' + bd.review_previous_day + "</b> 前日</span>" +
      '<span class="ratio__chip"><b>' + bd.review_7_days_ago + "</b> 7日前</span>" +
      '<span class="ratio__chip"><b>' + bd.base_bank + "</b> 基礎</span>";
    top.appendChild(ratio);
    head.appendChild(top);
    head.appendChild(el("div", "revcard__meta", "study_loop.breakdown の比率どおりに自動構成。タップで意味を表示。"));
    host.appendChild(head);

    var dot = { new: "dot-new", prev: "dot-prev", week: "dot-week", base: "dot-base" };
    rv.groups.forEach(function (grp) {
      var g = el("div", "revgroup");
      var gh = el("div", "revgroup__head");
      gh.appendChild(el("span", "revgroup__dot " + (dot[grp.key] || "")));
      gh.appendChild(el("h3", null, grp.label + "（" + grp.words.length + "）"));
      gh.appendChild(el("small", null, grp.sub));
      g.appendChild(gh);
      grp.words.forEach(function (w) {
        var c = el("div", "revcard" + (speechSupported() ? " speakable" : ""));
        var left = el("div");
        left.innerHTML = '<div class="revcard__w">' + esc(w.word) +
          (speechSupported() ? ' <span class="spk-inline">🔊</span>' : "") + "</div>" +
          (w.ipa ? '<div class="revcard__ipa">/' + esc(w.ipa) + "/</div>" : "") +
          (w.katakana ? '<div class="revcard__meta">' + esc(w.katakana) + "</div>" : "");
        var right = el("div", "revcard__reveal is-hidden", esc(w.meaning || "—"));
        c.appendChild(left); c.appendChild(right);
        c.addEventListener("click", function () {
          right.classList.toggle("is-hidden");
          speak(w.word);
        });
        g.appendChild(c);
      });
      host.appendChild(g);
    });

    var row = el("div", "btn-row");
    var q = el("button", "btn btn--primary", "この日のクイズへ →");
    q.addEventListener("click", function () { state.view = "quiz"; state.quiz = null; render(); });
    row.appendChild(q);
    host.appendChild(row);
  }

  function renderQuiz() {
    var host = document.getElementById("view-quiz");
    host.innerHTML = "";
    if (!state.quiz || state.quiz.day !== state.day) state.quiz = buildQuiz(state.day);
    var quiz = state.quiz;
    var answered = Object.keys(quiz.answers).length;
    var correctCount = quiz.questions.filter(function (q, i) { return quiz.answers[i] === q.correctIndex; }).length;

    var head = el("div", "card");
    var hh = el("div", "quiz-head");
    var t = el("div");
    t.innerHTML = '<div style="font-size:11px;letter-spacing:.12em;color:var(--muted)">DAY ' + state.day + " ・ 30秒チェック</div>" +
      '<div style="font-size:19px;font-weight:800;margin-top:2px">4択クイズ</div>';
    hh.appendChild(t);
    var sc = el("div", "quiz-score", "<b>" + correctCount + "</b> / " + quiz.questions.length);
    hh.appendChild(sc);
    head.appendChild(hh);
    head.appendChild(el("div", "revcard__meta", "日本語の意味に合う英単語を選ぼう。正解は新出語彙の word。"));
    host.appendChild(head);

    var doneAll = answered === quiz.questions.length;

    quiz.questions.forEach(function (q, qi) {
      var box = el("div", "card q");
      box.appendChild(el("div", "q__num", "Q" + (qi + 1)));
      var prompt = el("div", "q__prompt", esc(q.meaning));
      prompt.appendChild(el("small", null, "次の意味の英単語は？"));
      box.appendChild(prompt);

      var opts = el("div", "q__options");
      var chosen = quiz.answers[qi];
      q.options.forEach(function (opt, oi) {
        var b = el("button", "opt");
        b.type = "button";
        b.innerHTML = '<span class="opt__k">' + "ABCD"[oi] + "</span>" + esc(opt);
        if (chosen != null) {
          b.disabled = true;
          if (oi === q.correctIndex) b.classList.add("is-correct");
          else if (oi === chosen) b.classList.add("is-wrong");
        }
        b.addEventListener("click", function () {
          if (state.quiz.answers[qi] != null) return;
          state.quiz.answers[qi] = oi;
          render();
        });
        opts.appendChild(b);
      });
      box.appendChild(opts);

      var fb = el("div", "q__feedback");
      if (chosen != null) {
        if (chosen === q.correctIndex) fb.className += " ok", fb.textContent = "正解！ " + q.word;
        else fb.className += " ng", fb.textContent = "ざんねん… 正解は「" + q.word + "」";
        if (speechSupported()) {
          var sp = el("button", "spk", "🔊 発音");
          sp.type = "button";
          sp.addEventListener("click", function () { speak(q.word); });
          fb.appendChild(document.createTextNode(" "));
          fb.appendChild(sp);
        }
      }
      box.appendChild(fb);
      host.appendChild(box);
    });

    if (doneAll) {
      var done = el("div", "card quiz-done");
      done.appendChild(el("div", "quiz-done__score", correctCount + " / " + quiz.questions.length));
      var msg = correctCount === quiz.questions.length ? "パーフェクト！" :
        correctCount >= quiz.questions.length - 1 ? "あと少し！" : "もう一度やってみよう";
      done.appendChild(el("div", "quiz-done__msg", msg));
      var row = el("div", "btn-row");
      row.style.justifyContent = "center";
      var again = el("button", "btn btn--primary", "もう一度");
      again.addEventListener("click", function () { state.quiz = buildQuiz(state.day); render(); });
      var toReview = el("button", "btn", "復習を見る");
      toReview.addEventListener("click", function () { state.view = "review"; render(); });
      row.appendChild(again); row.appendChild(toReview);
      done.appendChild(row);
      host.appendChild(done);

      state.progress.quiz[state.day] = correctCount;
      saveProgress();
    }
  }

  function renderBase() {
    var host = document.getElementById("view-base");
    host.innerHTML = "";
    var head = el("div", "card");
    head.innerHTML = '<div style="font-size:11px;letter-spacing:.12em;color:var(--muted)">' +
      esc(DATA.base_bank.title || "基礎語彙") + '</div>' +
      '<div style="font-size:20px;font-weight:800;margin-top:2px">基礎 ' + baseItems.length + ' 語 ＋ 全' + (DATA.glossary || []).length + '語</div>' +
      '<div class="revcard__meta" style="margin-top:6px">検索すると意味・発音・出現日が見られます。</div>';
    host.appendChild(head);

    var input = el("input", "search");
    input.type = "search";
    input.placeholder = "単語・意味で検索（例: policy / 政策）";
    host.appendChild(input);

    var wrap = el("div");
    host.appendChild(wrap);

    function draw(q) {
      wrap.innerHTML = "";
      q = (q || "").trim().toLowerCase();
      var list = q
        ? (DATA.glossary || []).filter(function (g) {
            return (g.word || "").toLowerCase().indexOf(q) >= 0 || (g.meaning || "").indexOf(q) >= 0;
          })
        : baseItems.map(enrich);
      var grid = el("div", "basegrid");
      list.slice(0, 300).forEach(function (g) {
        var c = el("div", "basecard" + (speechSupported() ? " speakable" : ""));
        c.innerHTML = '<div class="basecard__w">' + esc(g.word) +
          (speechSupported() ? ' <span class="spk-inline">🔊</span>' : "") + "</div>" +
          (g.ipa ? '<div class="basecard__ipa">/' + esc(g.ipa) + "/</div>" : "") +
          '<div class="basecard__m">' + esc(g.meaning) + "</div>" +
          (g.days ? '<div class="basecard__d">出現: Day ' + g.days.join(", ") + "</div>" : "");
        if (speechSupported()) c.addEventListener("click", function () { speak(g.word); });
        grid.appendChild(c);
      });
      if (!list.length) wrap.appendChild(el("div", "revcard__meta", "見つかりませんでした。"));
      else wrap.appendChild(grid);
      if (list.length > 300) wrap.appendChild(el("div", "revcard__meta", "上位300件を表示中（" + list.length + "件）"));
    }
    input.addEventListener("input", function () { draw(input.value); });
    draw("");
  }

  /* ---------- day grid ---------- */
  function openDayGrid() {
    var grid = document.getElementById("dayGrid");
    var list = document.getElementById("dayGridList");
    list.innerHTML = "";
    DATA.days.forEach(function (d) {
      var c = el("div", "daycell" + (d.day === state.day ? " is-current" : "") +
        (state.progress.completed[d.day] ? " daycell--done" : "") +
        (d.type === "writing_model" ? " daycell--wm" : ""));
      c.innerHTML = '<div class="daycell__n">' + d.day + "</div>" +
        '<div class="daycell__t">' + esc(d.topic) + "</div>" +
        (d.type === "writing_model" ? '<div class="daycell__dot"></div>' : "");
      c.addEventListener("click", function () {
        state.day = d.day; state.quiz = null;
        grid.hidden = true; render();
      });
      list.appendChild(c);
    });
    grid.hidden = false;
  }

  /* ---------- wiring ---------- */
  function setDay(n) {
    n = Math.max(1, Math.min(TOTAL, n));
    if (n === state.day) return;
    state.day = n; state.quiz = null;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function wire() {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () {
        state.view = t.dataset.view;
        render();
      });
    });
    document.getElementById("prevDay").addEventListener("click", function () { setDay(state.day - 1); });
    document.getElementById("nextDay").addEventListener("click", function () { setDay(state.day + 1); });
    document.getElementById("dayPicker").addEventListener("click", openDayGrid);
    document.getElementById("dayGridClose").addEventListener("click", function () {
      document.getElementById("dayGrid").hidden = true;
    });
    document.getElementById("dayGrid").addEventListener("click", function (e) {
      if (e.target.id === "dayGrid") e.target.hidden = true;
    });
    document.getElementById("resetProgress").addEventListener("click", function () {
      if (confirm("学習の進捗とクイズ結果をすべて消しますか？")) {
        state.progress = { completed: {}, quiz: {} };
        saveProgress(); render();
      }
    });
    var vt = document.getElementById("voiceToggle");
    function paintVoice() {
      if (!speechSupported()) { vt.style.display = "none"; return; }
      vt.textContent = state.voice ? "🔊 読み上げ: ON" : "🔇 読み上げ: OFF";
      vt.classList.toggle("is-off", !state.voice);
    }
    vt.addEventListener("click", function () {
      state.voice = !state.voice;
      saveVoice(); paintVoice();
      if (state.voice) speak("Hello");
    });
    paintVoice();
    document.addEventListener("keydown", function (e) {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") setDay(state.day - 1);
      else if (e.key === "ArrowRight") setDay(state.day + 1);
    });

    /* swipe on main */
    var x0 = null, y0 = null;
    var main = document.getElementById("main");
    main.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    }, { passive: true });
    main.addEventListener("touchend", function (e) {
      if (x0 == null) return;
      var dx = e.changedTouches[0].clientX - x0;
      var dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        setDay(state.day + (dx < 0 ? 1 : -1));
      }
      x0 = y0 = null;
    }, { passive: true });
  }

  /* ---------- PWA ---------- */
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
  function iosInstallHint() {
    var ua = navigator.userAgent || "";
    var isIOS = /iPhone|iPad|iPod/.test(ua) && !window.MSStream;
    var standalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    if (!isIOS || standalone) return;
    if (localStorage.getItem("vocab_app_ios_hint") === "done") return;
    var bar = el("div", "ioshint");
    bar.innerHTML = '<span>共有 <b>⬆︎</b> → <b>ホーム画面に追加</b> でアプリのように使えます</span>';
    var x = el("button", "ioshint__x", "✕");
    x.addEventListener("click", function () {
      localStorage.setItem("vocab_app_ios_hint", "done");
      bar.remove();
    });
    bar.appendChild(x);
    document.body.appendChild(bar);
  }

  /* ---------- boot ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    loadProgress();
    loadVoice();
    if (speechSupported()) {
      try { window.speechSynthesis.getVoices(); } catch (e) {}
      window.speechSynthesis.addEventListener("voiceschanged", function () {
        try { window.speechSynthesis.getVoices(); } catch (e) {}
      });
    }
    registerSW();
    loadData().then(function () {
      if (!DATA) return;
      wire();
      render();
      iosInstallHint();
    });
  });
})();
