// public/assets/arka-page.js
document.addEventListener("DOMContentLoaded", () => {
  if (!window.TepihaArka) return;

  const Arka = window.TepihaArka;
  const user = Arka.getCurrentUser();

  if (!user) {
    // Nëse nuk ka user në session, le të vazhdojë UI, por njofto përdoruesin
    console.warn("Nuk ka user të loguar në ARKË. Disa veprime nuk do të funksionojnë pa PIN.");
  }

  // PANELI I PËRDORUESVE (vetëm ADMIN)
  const userPanel = document.getElementById("user_admin_panel");
  if (userPanel) {
    if (!user || user.role !== "admin") {
      userPanel.style.display = "none";
    } else {
      const nameInput = document.getElementById("user_name_input");
      const pinInput = document.getElementById("user_pin_input");
      const roleSelect = document.getElementById("user_role_select");
      const addBtn = document.getElementById("btn_add_user");
      const listEl = document.getElementById("user_list");
      const emptyEl = document.getElementById("user_list_empty");

      function renderUsers() {
        const users = Arka.listUsers();
        listEl.innerHTML = "";
        const visible = users.filter(u => u.active !== false);

        if (!visible.length) {
          emptyEl.style.display = "block";
          return;
        }
        emptyEl.style.display = "none";

        visible.forEach(u => {
          const li = document.createElement("li");
          li.textContent = `${u.name} • ${u.role.toUpperCase()}`;
          listEl.appendChild(li);
        });
      }

      addBtn.addEventListener("click", () => {
        const name = nameInput.value.trim();
        const pin = pinInput.value.trim();
        const role = roleSelect.value;

        if (!name || !pin) {
          alert("Emri dhe PIN-i janë të obligueshëm.");
          return;
        }
        try {
          Arka.addUser({ name, pin, role });
          nameInput.value = "";
          pinInput.value = "";
          roleSelect.value = "worker";
          renderUsers();
          alert("Përdoruesi u shtua.");
        } catch (e) {
          alert(e.message || "Gabim gjatë shtimit të përdoruesit.");
        }
      });

      renderUsers();
    }
  }

  // DITA: HAPJE + MBYLLJE
  const openCashInput = document.getElementById("open_cash_input");
  const btnOpenDay = document.getElementById("btn_open_day");
  const btnCloseDay = document.getElementById("btn_close_day");
  const dayInfoText = document.getElementById("day_info_text");

  function renderDayInfo() {
    const summary = Arka.getArkaSummary();
    const day = summary.currentDay;
    if (!day) {
      if (dayInfoText) {
        dayInfoText.textContent =
          "Nuk ka ditë të hapur. Shkruaj CASH START dhe shtyp HAPE DITËN.";
      }
      return;
    }
    if (dayInfoText) {
      dayInfoText.textContent =
        `DITA: ${day.id} • CASH START: ${Arka.formatEuros(day.cashStartCents)} €` +
        ` • CASH TANI: ${Arka.formatEuros(day.cashNowCents)} €` +
        ` • TË ARDHURA SOT: ${Arka.formatEuros(day.incomeCents)} €` +
        ` • SHPENZIME ARKA: ${Arka.formatEuros(day.arkaExpensesCents)} €` +
        ` • AVANSA ARKA: ${Arka.formatEuros(day.arkaAdvancesCents)} €`;
    }
  }

  if (btnOpenDay) {
    btnOpenDay.addEventListener("click", () => {
      const val = openCashInput ? openCashInput.value : "0";
      try {
        Arka.openDay(val || 0);
        renderDayInfo();
        alert("Dita u hap.");
      } catch (e) {
        alert(e.message || "Gabim gjatë hapjes së ditës.");
      }
    });
  }

  if (btnCloseDay) {
    btnCloseDay.addEventListener("click", () => {
      try {
        const { cashEndCents, day } = Arka.closeDayAndProposeTransfer();
        const ok = confirm(
          `CASH NË FUND DITE: ${Arka.formatEuros(cashEndCents)} €.\n` +
          `Dëshiron ta transferosh këtë shumë në BUXHET? (Vetëm ADMIN)`
        );
        if (ok) {
          try {
            Arka.transferCashEndToBudget(day.id, cashEndCents);
            alert("Shuma u transferua në BUXHET.");
          } catch (e2) {
            alert(e2.message || "Gabim gjatë transferit në buxhet.");
          }
        }
        renderDayInfo();
      } catch (e) {
        alert(e.message || "Gabim gjatë mbylljes së ditës.");
      }
    });
  }

  // AVANS / SHPENZIM / TOP-UP
  const avansBtn = document.getElementById("btn_avans");
  if (avansBtn) {
    avansBtn.addEventListener("click", () => {
      const nameEl = document.getElementById("avans_name");
      const amountEl = document.getElementById("avans_amount");
      const sourceEl = document.getElementById("avans_source");
      const noteEl = document.getElementById("avans_note");

      const name = nameEl ? nameEl.value.trim() : "";
      const amount = amountEl ? amountEl.value : "";
      const source = sourceEl ? sourceEl.value : "arka";
      const note = noteEl ? noteEl.value : "";

      if (!name || !amount) {
        alert("Emri dhe shuma janë të obligueshme.");
        return;
      }

      try {
        Arka.registerMove({
          type: "advance",
          source,
          amountEuros: amount,
          who: name,
          note
        });
        alert("Avansi u regjistrua.");
        renderDayInfo();
        renderMoves();
      } catch (e) {
        alert(e.message || "Gabim gjatë regjistrimit të avansit.");
      }
    });
  }

  const shpenzimBtn = document.getElementById("btn_shpenzim");
  if (shpenzimBtn) {
    shpenzimBtn.addEventListener("click", () => {
      const amountEl = document.getElementById("shpenzim_amount");
      const sourceEl = document.getElementById("shpenzim_source");
      const noteEl = document.getElementById("shpenzim_note");

      const amount = amountEl ? amountEl.value : "";
      const source = sourceEl ? sourceEl.value : "arka";
      const note = noteEl ? noteEl.value : "";

      if (!amount) {
        alert("Shuma është e obligueshme.");
        return;
      }

      try {
        Arka.registerMove({
          type: "expense",
          source,
          amountEuros: amount,
          who: null,
          note
        });
        alert("Shpenzimi u regjistrua.");
        renderDayInfo();
        renderMoves();
      } catch (e) {
        alert(e.message || "Gabim gjatë regjistrimit të shpenzimit.");
      }
    });
  }

  const topupBtn = document.getElementById("btn_topup");
  if (topupBtn) {
    topupBtn.addEventListener("click", () => {
      const amountEl = document.getElementById("topup_amount");
      const whoEl = document.getElementById("topup_who");
      const noteEl = document.getElementById("topup_note");

      const amount = amountEl ? amountEl.value : "";
      const who = whoEl ? whoEl.value.trim() : "";
      const note = noteEl ? noteEl.value : "";

      if (!amount || !who) {
        alert("Shuma dhe kush i dha janë të obligueshme.");
        return;
      }

      try {
        Arka.registerMove({
          type: "topup",
          source: "external",
          amountEuros: amount,
          who,
          note
        });
        alert("TOP-UP u regjistrua.");
        renderDayInfo();
        renderMoves();
      } catch (e) {
        alert(e.message || "Gabim gjatë TOP-UP.");
      }
    });
  }

  // LISTA E LËVIZJEVE
  const movesEmpty = document.getElementById("moves_empty");
  const movesList = document.getElementById("moves_list");

  function renderMoves() {
    if (!movesList || !movesEmpty) return;
    const summary = Arka.getArkaSummary();
    const today = summary.currentDay ? summary.currentDay.id : new Date().toISOString().slice(0, 10);
    const moves = summary.moves.filter(m => m.dayId === today);

    movesList.innerHTML = "";
    if (!moves.length) {
      movesEmpty.style.display = "block";
      return;
    }
    movesEmpty.style.display = "none";

    moves
      .sort((a, b) => a.ts - b.ts)
      .forEach(m => {
        const li = document.createElement("li");
        const amount = Arka.formatEuros(m.amountCents);
        li.textContent =
          `[${m.type.toUpperCase()} • ${m.source}] ` +
          `${amount} €` +
          (m.who ? ` • ${m.who}` : "") +
          (m.note ? ` • ${m.note}` : "");
        movesList.appendChild(li);
      });
  }

  renderDayInfo();
  renderMoves();
});
