/* ============================================================
   Hudd Darts — site.js

   Static site (GitHub Pages) — no backend, so player data can't be
   written to playerdata.csv on the server directly. Instead:
     * playerdata.csv seeds the data on first load
     * all edits (new players, recorded results) persist to
       localStorage, so they survive reloads and show everywhere
     * "Download CSV" exports the current data so it can be
       committed back to the repo when you want it permanent

   Powers the landing-page leaderboard DataTable and the tournament
   (add players -> randomised bracket -> record results).
   ============================================================ */

(function () {
  "use strict";

  var CSV_URL = "playerdata.csv";
  var STORE_KEY = "huddDartsPlayers";

  /* ============================================================
     Player store (CSV-seeded, localStorage-backed)
     ============================================================ */

  var store = null;   // in-memory array of player records (source of truth)

  // CSV columns: PlayerId, PlayerName, GamesPlayed, Average, PlayerFilePath
  // Lines beginning with "//" are treated as comments and skipped.
  function parseCsv(text) {
    var rows = [];
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.indexOf("//") === 0) { continue; }

      var cols = line.split(",");
      if (cols.length < 4) { continue; }

      rows.push({
        id:          (cols[0] || "").trim(),
        name:        (cols[1] || "").trim(),
        gamesPlayed: parseInt(cols[2], 10) || 0,
        average:     parseFloat(cols[3]) || 0,
        filePath:    (cols[4] || "").trim()
      });
    }
    return rows;
  }

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
    catch (e) { /* storage unavailable — keep working in-memory */ }
  }

  // Loads players once and hands the array to `cb`. Uses localStorage if
  // present, otherwise seeds it from the CSV.
  function loadPlayers(cb) {
    if (store) { cb(store); return; }

    var saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { /* ignore */ }
    if (saved) {
      try { store = JSON.parse(saved); } catch (e) { store = null; }
    }
    if (store) { cb(store); return; }

    $.ajax({ url: CSV_URL, dataType: "text" })
      .done(function (text) { store = parseCsv(text); persist(); cb(store); })
      .fail(function () { store = []; cb(store); });
  }

  function nextId() {
    var max = -1;
    store.forEach(function (p) {
      var n = parseInt(p.id, 10);
      if (!isNaN(n) && n > max) { max = n; }
    });
    return String(max + 1);
  }

  function addPlayerRecord(name, avg) {
    var player = {
      id: nextId(),
      name: name,
      gamesPlayed: 0,
      average: Number(avg) || 0,
      filePath: ""
    };
    store.push(player);
    persist();
    return player;
  }

  // Folds a single game's 3-dart average into a player's career stats.
  function recordGame(player, gameAvg) {
    var oldGames = player.gamesPlayed || 0;
    player.average = (player.average * oldGames + gameAvg) / (oldGames + 1);
    player.gamesPlayed = oldGames + 1;
    persist();
  }

  function toCsv() {
    var lines = [
      "//Player Data",
      "//PlayerId,PlayerName,GamesPlayed,Average,PlayerFilePath"
    ];
    store.forEach(function (p) {
      lines.push([
        p.id, p.name, p.gamesPlayed, Number(p.average).toFixed(2), p.filePath || ""
      ].join(","));
    });
    return lines.join("\n");
  }

  function downloadCsv() {
    var blob = new Blob([toCsv()], { type: "text/csv" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "playerdata.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ============================================================
     Shared helpers
     ============================================================ */

  function setText(sel, value) {
    var $el = $(sel);
    if ($el.length) { $el.text(value); }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ============================================================
     Landing page — leaderboard DataTable
     ============================================================ */

  function buildLeaderboardTable() {
    var $table = $("#leaderboard-table");
    if (!$table.length) { return; }              // only on the landing page

    loadPlayers(function (players) {
      var leaderboardTable = $table.DataTable({
        data: players,
        order: [[3, "desc"]],
        paging: players.length > 10,
        searching: players.length > 5,
        info: players.length > 10,
        lengthChange: false,
        pageLength: 10,
        language: { emptyTable: "No player data available." },
        columns: [
          { data: null, orderable: false, searchable: false, className: "rank-col" },
          { data: "name",        title: "Player" },
          { data: "gamesPlayed", title: "Games Played" },
          {
            data: "average",
            title: "3-Dart Avg",
            render: function (value) { return Number(value).toFixed(2); }
          }
        ]
      });

      leaderboardTable.on("order.dt search.dt draw.dt", function () {
        leaderboardTable
          .column(0, { search: "applied", order: "applied" })
          .nodes()
          .each(function (cell, i) { cell.innerHTML = i + 1; });
      }).draw();

      setText("#registered-player-count", players.length);
      if (players.length) {
        var avg = players.reduce(function (s, p) { return s + p.average; }, 0) / players.length;
        setText("#team-avg-count", avg.toFixed(2));
      }
    });
  }

  /* ============================================================
     Tournament page — players -> randomised bracket -> results
     ============================================================ */

  var $select;          // "Add Players" <select>
  var $cardWrapper;     // container the selected-player cards live in
  var $startBtn;        // "Start Tournament" button
  var selected = [];    // players added to this tournament
  var bracket = null;   // array of rounds; each round is an array of match objects
  var currentMatch = null;  // match whose result modal is open

  function initTournament() {
    if (!$("#pregame-wrapper").length) { return; }   // only on the tournament page

    $select      = $("#pregame-wrapper select");
    $cardWrapper = $(".player-select-wrapper");
    $startBtn    = $("#start-tournament");

    $("#create-tournament").on("click", function (e) {
      e.preventDefault();
      buildPlayerSelect();
      $("#pregame-wrapper").removeClass("d-none");
      setText("#status", "Setup");
    });

    $select.on("change", function () { addPlayer($select.val()); });

    $cardWrapper.on("click", ".remove-player-btn", function () {
      removePlayer($(this).closest(".playerCard").data("id"));
    });

    $startBtn.on("click", startTournament);

    // Add-new-player flow
    $("#add-new-player").on("click", function () {
      $("#new-player-name").val("");
      $("#new-player-avg").val("");
      modal("add-player-modal").show();
    });
    $("#save-new-player").on("click", saveNewPlayer);

    // Export data as CSV
    $("#download-csv").on("click", downloadCsv);

    // Record-result flow (bracket matches are added dynamically -> delegate)
    $("#bracket-wrapper").on("click", ".bracket-match.is-playable", function () {
      openGameModal(+$(this).data("round"), +$(this).data("index"));
    });
    $("#save-game-result").on("click", saveGameResult);
  }

  function modal(id) {
    return bootstrap.Modal.getOrCreateInstance(document.getElementById(id));
  }

  /* ---------- player select + cards ---------- */

  function buildPlayerSelect() {
    loadPlayers(function (players) {
      selected = [];
      bracket = null;
      $cardWrapper.empty();
      $("#bracket-wrapper").empty();
      $select.empty().append($("<option>", { value: "", text: "Select a player to add…" }));
      players.forEach(addSelectOption);
      refreshState();
    });
  }

  function addSelectOption(player) {
    $select.append($("<option>", {
      value: player.id,
      text: player.name + "  ·  avg " + player.average.toFixed(2)
    }));
  }

  function addPlayer(id) {
    if (!id) { return; }
    var player = findPlayer(id);
    if (!player || isSelected(id)) { $select.val(""); return; }

    selected.push(player);
    $cardWrapper.append(
      '<div class="playerCard" id="player-' + player.id + '" data-id="' + player.id + '">' +
        "<p>Selected Player: " + escapeHtml(player.name) + "</p>" +
        '<button type="button" class="remove-player-btn">Remove</button>' +
      "</div>"
    );
    $select.find('option[value="' + player.id + '"]').prop("disabled", true);
    $select.val("");
    refreshState();
  }

  function removePlayer(id) {
    selected = selected.filter(function (p) { return String(p.id) !== String(id); });
    $cardWrapper.find('.playerCard[data-id="' + id + '"]').remove();
    $select.find('option[value="' + id + '"]').prop("disabled", false);
    refreshState();
  }

  function refreshState() {
    var count = selected.length;
    $("#players-select-card").find("#player-count").text(count);
    $("#content-grid").find("#player-count").text(count);
    $startBtn.prop("disabled", count < 2);
  }

  function saveNewPlayer() {
    var name = ($("#new-player-name").val() || "").trim();
    if (!name) { $("#new-player-name").focus(); return; }
    var avg = parseFloat($("#new-player-avg").val());

    var player = addPlayerRecord(name, isNaN(avg) ? 0 : avg);
    addSelectOption(player);                 // available to add to the tournament
    modal("add-player-modal").hide();
  }

  function findPlayer(id) {
    for (var i = 0; i < selected.length; i++) {
      if (String(selected[i].id) === String(id)) { return selected[i]; }
    }
    for (var j = 0; j < store.length; j++) {
      if (String(store[j].id) === String(id)) { return store[j]; }
    }
    return null;
  }

  function isSelected(id) {
    return selected.some(function (p) { return String(p.id) === String(id); });
  }

  /* ---------- bracket model ---------- */

  // Builds a single-elimination bracket with players RANDOMLY allocated.
  // Returns an array of rounds; each round is an array of match objects:
  //   { round, index, slots:[a,b], avgs:[n,n], winner, next, nextSlot }
  function startTournament() {
    if (selected.length < 2) { return; }

    var players = shuffle(selected.slice());     // random allocation
    var size = 1;
    while (size < players.length) { size *= 2; }
    while (players.length < size) { players.push(null); }   // byes

    var roundCount = Math.round(Math.log(size) / Math.log(2));
    var rounds = [];
    var matchesInRound = size / 2;
    for (var r = 0; r < roundCount; r++) {
      var round = [];
      for (var i = 0; i < matchesInRound; i++) {
        round.push({
          round: r, index: i,
          slots: [null, null], avgs: [null, null],
          winner: null, next: null, nextSlot: null
        });
      }
      rounds.push(round);
      matchesInRound = matchesInRound / 2;
    }

    // Link each match to the one it feeds into.
    for (var rr = 0; rr < roundCount - 1; rr++) {
      rounds[rr].forEach(function (m, i) {
        m.next = rounds[rr + 1][Math.floor(i / 2)];
        m.nextSlot = i % 2;
      });
    }

    // Seed the first round from the shuffled list.
    rounds[0].forEach(function (m, i) {
      m.slots[0] = players[i * 2];
      m.slots[1] = players[i * 2 + 1];
    });

    // Auto-advance byes (a real player facing an empty slot).
    rounds[0].forEach(function (m) {
      var a = m.slots[0], b = m.slots[1];
      if (a && !b) { advanceWinner(m, a); }
      else if (b && !a) { advanceWinner(m, b); }
    });

    bracket = rounds;
    renderBracket();
    $("#pregame-wrapper").addClass("d-none");
    setText("#status", "In progress");
    setText("#round-count", roundCount);
  }

  function advanceWinner(match, player) {
    match.winner = player;
    if (match.next) { match.next.slots[match.nextSlot] = player; }
  }

  /* ---------- bracket rendering ---------- */

  function roundTitle(matchCount) {
    if (matchCount === 1) { return "Final"; }
    if (matchCount === 2) { return "Semi-Finals"; }
    if (matchCount === 4) { return "Quarter-Finals"; }
    return "Round of " + (matchCount * 2);
  }

  function seedHtml(match, slotIndex, roundIndex) {
    var player = match.slots[slotIndex];
    if (!player) {
      var label = roundIndex === 0 ? "Bye" : "TBD";
      return '<div class="bracket-seed is-empty"><span class="bracket-seed-name">' +
             label + "</span></div>";
    }
    var cls = "bracket-seed";
    if (match.winner && String(match.winner.id) === String(player.id)) { cls += " is-winner"; }
    var avg = match.avgs[slotIndex] != null
      ? match.avgs[slotIndex].toFixed(2)
      : player.average.toFixed(2);
    return '<div class="' + cls + '">' +
             '<span class="bracket-seed-name">' + escapeHtml(player.name) + "</span>" +
             '<span class="bracket-seed-avg">' + avg + "</span>" +
           "</div>";
  }

  function renderBracket() {
    var $wrap = $("#bracket-wrapper").empty();
    var $bracket = $('<div class="bracket"></div>');

    bracket.forEach(function (round, roundIndex) {
      var $round = $('<div class="bracket-round"></div>');
      $round.append('<div class="bracket-round-title">' + roundTitle(round.length) + "</div>");

      var $matches = $('<div class="bracket-round-matches"></div>');
      round.forEach(function (m) {
        var playable = m.slots[0] && m.slots[1] && !m.winner;
        var classes = "bracket-match" +
          (playable ? " is-playable" : "") +
          (m.winner ? " is-done" : "");
        $matches.append(
          '<div class="' + classes + '" data-round="' + m.round + '" data-index="' + m.index + '">' +
            seedHtml(m, 0, roundIndex) +
            seedHtml(m, 1, roundIndex) +
          "</div>"
        );
      });

      $round.append($matches);
      $bracket.append($round);
    });

    $wrap.append($bracket);
  }

  /* ---------- record-result modal ---------- */

  function openGameModal(roundIndex, matchIndex) {
    currentMatch = bracket[roundIndex][matchIndex];
    var a = currentMatch.slots[0], b = currentMatch.slots[1];
    if (!a || !b) { return; }

    $("#gm-p1-name").text(a.name);
    $("#gm-p2-name").text(b.name);
    $("#gm-p1-label").text(a.name + " average");
    $("#gm-p2-label").text(b.name + " average");
    $("#gm-winner-1-label").text(a.name);
    $("#gm-winner-2-label").text(b.name);
    $("#gm-p1-avg").val(a.average ? a.average.toFixed(2) : "");
    $("#gm-p2-avg").val(b.average ? b.average.toFixed(2) : "");
    $('input[name="gm-winner"]').prop("checked", false);
    $("#gm-error").addClass("d-none");

    modal("game-modal").show();
  }

  function saveGameResult() {
    if (!currentMatch) { return; }
    var a = currentMatch.slots[0], b = currentMatch.slots[1];
    var avg1 = parseFloat($("#gm-p1-avg").val());
    var avg2 = parseFloat($("#gm-p2-avg").val());
    var winnerVal = $('input[name="gm-winner"]:checked').val();

    if (isNaN(avg1) || isNaN(avg2) || avg1 < 0 || avg2 < 0 || !winnerVal) {
      $("#gm-error").removeClass("d-none");
      return;
    }

    // Record the game averages against each player's career stats (-> store/CSV).
    currentMatch.avgs = [avg1, avg2];
    recordGame(a, avg1);
    recordGame(b, avg2);

    // Advance the winner into the next round and re-render.
    advanceWinner(currentMatch, winnerVal === "1" ? a : b);
    renderBracket();

    // Final decided?
    var finalMatch = bracket[bracket.length - 1][0];
    if (finalMatch.winner) { setText("#status", "Complete"); }

    modal("game-modal").hide();
    currentMatch = null;
  }

  /* ============================================================
     Init
     ============================================================ */
  $(function () {
    buildLeaderboardTable();
    initTournament();
  });
})();
