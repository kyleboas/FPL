// matrixPreview.js
(function () {
  'use strict';

  // --- Configuration ---

  const teams = ["ARS", "AVL", "BHA", "CHE", "LIV", "MCI", "NEW", "TOT"];
  const gameweeks = [15, 16, 17, 18, 19, 20, 21, 22];
  const opponents = ["WOL", "FUL", "IPS", "SOU", "EVE", "NFO", "BRE", "WHU"];

  const VIEW_WINDOW_SIZE = 5;
  const LAYOUT = {
    headerHeight: 40,
    rowLabelWidth: 60
  };

  const mockData = {};

  function generateMockData() {
    const archetypes = ['CB', 'LB', 'RB', 'MID', 'FWD'];

    archetypes.forEach((arch) => {
      mockData[arch] = {};

      teams.forEach((team, tIndex) => {
        mockData[arch][team] = {};

        gameweeks.forEach((gw, gIndex) => {
          const isHome = (tIndex + gIndex) % 2 === 0;
          const opponent = opponents[(tIndex + gIndex) % opponents.length];

          let baseProb = (Math.sin(tIndex * gIndex) + 1) / 2; // 0–1

          if (arch === 'CB') baseProb = Math.min(1, baseProb + 0.1);
          if (arch === 'FWD') baseProb = Math.max(0, baseProb - 0.1);

          mockData[arch][team][gw] = {
            opponent,
            venue: isHome ? 'H' : 'A',
            probability: parseFloat(baseProb.toFixed(2))
          };
        });
      });
    });
  }

  // --- Color helpers ---

  function getCellColor(prob) {
    // 0 = greenish, 1 = reddish-ish within a 0–60° hue range
    const h = (1 - prob) * 60;
    const s = 90;
    const l = 95 - prob * 50;
    return `hsl(${h}, ${s}%, ${l}%)`;
  }

  function getTextColor(prob) {
    return prob > 0.6 ? '#ffffff' : '#1e293b';
  }

  // --- Public init function ---

  function initMatrixPreview() {
    const canvas = document.getElementById('defconCanvas');
    const container = document.getElementById('canvasContainer');
    const slider = document.getElementById('gwRange');
    const sliderLabel = document.getElementById('gwLabel');
    const select = document.getElementById('archetypeSelect');

    if (!canvas || !container || !slider || !sliderLabel || !select) {
      console.warn('[MatrixPreview] Required DOM elements not found. Skipping init.');
      return;
    }

    const ctx = canvas.getContext('2d');

    const state = {
      currentStartGwIndex: 0,
      currentArchetype: 'CB'
    };

    let lastWidth = 0;
    let lastHeight = 0;
    let lastDpr = window.devicePixelRatio || 1;

    function updateLabel() {
      const startGW = gameweeks[state.currentStartGwIndex];
      const endGW = gameweeks[
        Math.min(
          state.currentStartGwIndex + VIEW_WINDOW_SIZE - 1,
          gameweeks.length - 1
        )
      ];
      sliderLabel.textContent = `GW ${startGW} - ${endGW}`;
    }

    function draw() {
      const width = lastWidth;
      const height = lastHeight;

      if (!width || !height) return;

      ctx.clearRect(0, 0, width, height);

      const gridWidth = width - LAYOUT.rowLabelWidth;
      const gridHeight = height - LAYOUT.headerHeight;
      const cellWidth = gridWidth / VIEW_WINDOW_SIZE;
      const cellHeight = gridHeight / teams.length;

      const archetypeData = mockData[state.currentArchetype];

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Rows (teams)
      for (let r = 0; r < teams.length; r++) {
        const team = teams[r];
        const teamY = LAYOUT.headerHeight + r * cellHeight;

        // Team label background
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(0, teamY, LAYOUT.rowLabelWidth, cellHeight);

        // Team label text
        ctx.fillStyle = '#334155';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(team, LAYOUT.rowLabelWidth / 2, teamY + cellHeight / 2);

        // Cells for each GW in view
        for (let c = 0; c < VIEW_WINDOW_SIZE; c++) {
          const gwIndex = state.currentStartGwIndex + c;
          if (gwIndex >= gameweeks.length) continue;

          const gw = gameweeks[gwIndex];
          const cellX = LAYOUT.rowLabelWidth + c * cellWidth;
          const fixture = archetypeData[team][gw];

          // Cell background
          ctx.fillStyle = getCellColor(fixture.probability);
          ctx.fillRect(cellX, teamY, cellWidth, cellHeight);

          // Grid line
          ctx.strokeStyle = 'rgba(0,0,0,0.05)';
          ctx.strokeRect(cellX, teamY, cellWidth, cellHeight);

          // Opponent label
          ctx.fillStyle = getTextColor(fixture.probability);
          ctx.font = 'bold 14px sans-serif';
          ctx.fillText(
            fixture.opponent,
            cellX + cellWidth / 2,
            teamY + cellHeight / 2 - 8
          );

          // Venue + probability
          ctx.font = '11px sans-serif';
          ctx.globalAlpha = 0.8;
          const venueText = `(${fixture.venue}) ${Math.round(
            fixture.probability * 100
          )}%`;
          ctx.fillText(
            venueText,
            cellX + cellWidth / 2,
            teamY + cellHeight / 2 + 10
          );
          ctx.globalAlpha = 1.0;
        }
      }

      // Column header background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(LAYOUT.rowLabelWidth, 0, gridWidth, LAYOUT.headerHeight);

      // Column header labels (GWs)
      ctx.fillStyle = '#334155';
      ctx.font = 'bold 13px sans-serif';
      for (let c = 0; c < VIEW_WINDOW_SIZE; c++) {
        const gwIndex = state.currentStartGwIndex + c;
        if (gwIndex >= gameweeks.length) continue;

        const gw = gameweeks[gwIndex];
        const cellX = LAYOUT.rowLabelWidth + c * cellWidth;
        ctx.fillText(`GW ${gw}`, cellX + cellWidth / 2, LAYOUT.headerHeight / 2);
      }

      // Header cell for team column
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(0, 0, LAYOUT.rowLabelWidth, LAYOUT.headerHeight);
    }

    function resizeCanvas() {
      const rect = container.getBoundingClientRect();
      lastWidth = rect.width;
      lastHeight = rect.height || 320; // fallback height

      lastDpr = window.devicePixelRatio || 1;

      canvas.width = lastWidth * lastDpr;
      canvas.height = lastHeight * lastDpr;

      // Reset transform before applying new scale (important!)
      ctx.setTransform(lastDpr, 0, 0, lastDpr, 0, 0);

      draw();
    }

    function handleSliderInput(event) {
      state.currentStartGwIndex = parseInt(event.target.value, 10) || 0;
      updateLabel();
      window.requestAnimationFrame(draw);
    }

    function handleSelectChange(event) {
      state.currentArchetype = event.target.value;
      console.log(`Switched to Archetype: ${state.currentArchetype}`);
      window.requestAnimationFrame(draw);
    }

    function handleCanvasClick(event) {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;

      const gridWidth = width - LAYOUT.rowLabelWidth;
      const gridHeight = height - LAYOUT.headerHeight;
      const cellWidth = gridWidth / VIEW_WINDOW_SIZE;
      const cellHeight = gridHeight / teams.length;

      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      if (mouseX > LAYOUT.rowLabelWidth && mouseY > LAYOUT.headerHeight) {
        const colIndex = Math.floor((mouseX - LAYOUT.rowLabelWidth) / cellWidth);
        const rowIndex = Math.floor((mouseY - LAYOUT.headerHeight) / cellHeight);

        if (
          rowIndex >= 0 &&
          rowIndex < teams.length &&
          colIndex >= 0 &&
          colIndex < VIEW_WINDOW_SIZE
        ) {
          const actualGWIndex = state.currentStartGwIndex + colIndex;
          if (actualGWIndex < gameweeks.length) {
            const team = teams[rowIndex];
            const gw = gameweeks[actualGWIndex];
            const data = mockData[state.currentArchetype][team][gw];

            console.log('--- Cell Clicked ---');
            console.log(`Team: ${team}`);
            console.log(`Gameweek: ${gw}`);
            console.log(`Opponent: ${data.opponent} (${data.venue})`);
            console.log(
              `Probability (${state.currentArchetype}): ${data.probability}`
            );
            console.log('--------------------');
          }
        }
      }
    }

    // --- Event wiring and initialisation ---

    // Slider range based on gameweeks length
    slider.max = String(Math.max(0, gameweeks.length - VIEW_WINDOW_SIZE));
    slider.value = String(state.currentStartGwIndex);

    slider.addEventListener('input', handleSliderInput);
    select.addEventListener('change', handleSelectChange);
    canvas.addEventListener('click', handleCanvasClick);
    window.addEventListener('resize', resizeCanvas);

    generateMockData();
    updateLabel();
    resizeCanvas();
  }

  // Expose single global entrypoint
  window.initMatrixPreview = initMatrixPreview;
})();