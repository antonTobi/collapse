// ============================================================================
// Box Class
// ============================================================================

class Box {
    constructor(n, x, y) {
        Object.assign(this, { n, x, y, vy: 0 });
    }

    draw(gridI, gridJ) {
        if (this.y < 0) return;
        if (this.n === 0) return;
        fill(boxColors[this.n]);
        noStroke();
        square(this.x + 1, this.y + 1, S - 2);

        // Check if this tile is in a locked region based on challenge mode
        let challengeMode = (typeof settings !== 'undefined') ? settings.challengeMode : "none";
        let isLocked = (challengeMode === "bottomrow" && gridJ === 0) ||
            (challengeMode === "middlecolumn" && gridI === 2);

        textSize(0.7 * S);
        let x = this.x + S * 0.5;
        let y = this.y + S * 0.5;
        if (this.n < 6) {
            // Draw number at 50% opacity if locked, full opacity otherwise
            if (!isLocked) {
                noStroke()
                fill(255, 230)
                // Use actual text metrics for precise vertical centering across all platforms
                let metrics = drawingContext.measureText(this.n.toString());
                let yOffset = (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
                text(this.n, x, y + yOffset);
            }
        } else {
            // Draw shape centered in the tile (shapes are always shown)
            if (this.shape) drawShape(this.shape, x, y, 9, 200);
        }
    }
}

// ============================================================================
// NumberGrid Class
// ============================================================================

class NumberGrid {
    constructor(w, h, seed = Date.now(), moves = "", skipAnimation = false, options = {}) {
        this.w = w;
        this.h = h;
        this.score = 0;
        this.settled = true;
        this.seed = seed;
        this.state = seed % m;
        this.moves = [];
        this.maxGen = 3;
        this.noRefill = options.noRefill ?? false;
        this.offsetX = options.offsetX ?? X;
        this.offsetY = options.offsetY ?? Y;

        for (let i = 0; i < this.w; i++) {
            this[i] = [];
            for (let j = 0; j < this.h; j++) {
                const boxX = this.offsetX + S * i;
                const boxY = this.offsetY + S * (this.h - 1 - j);
                this[i].push(new Box(0, boxX, boxY));
            }
        }

        this.scoreSplits = []; // Simple list: [score@6, score@6, ..., finalScore]
        this.scoreSplitDiff = null;
        this.polyominoList = [];
        this.isReplaying = false;
        this.largestChains = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; // Track largest chain for each tile type
        this.firstMoveTime = null; // Time of first move
        this.lastMoveTime = null; // Time of final move
        this.positionHeatmap = []; // Track how many times each position was clicked
        for (let i = 0; i < w; i++) {
            this.positionHeatmap[i] = [];
            for (let j = 0; j < h; j++) {
                this.positionHeatmap[i][j] = 0;
            }
        }

        this.refill();

        if (moves.length || skipAnimation) {
            this.isReplaying = true;
            let tic = performance.now();
            for (let c of moves) {
                let k = tebahpla[c];
                let i = k % 5;
                let j = (k - i) / 5;
                this.do(i, j);
            }

            // Snap all boxes to their final positions (skip animation)
            for (let i = 0; i < this.w; i++) {
                for (let j = 0; j < this.h; j++) {
                    let box = this[i][j];
                    box.y = Y + S * (this.h - 1 - j);
                    box.vy = 0;
                }
            }

            let toc = performance.now();

            if (moves.length) {
                console.log(`Replayed ${moves.length} moves in ${toc - tic} ms`);
            }
            this.isReplaying = false;
        }
        this.gameOver = this.noLegalMoves();
        this.displayScore = this.score;
    }

    // Get the splits array (scores at each 6 creation, plus final score)
    get sixSplits() {
        return this.scoreSplits;
    }

    // Check if any splits exist (any 6 created)
    get hasSplits() {
        return this.scoreSplits.length > 0;
    }

    get split() {
        // Get points since last 6 (or since start if no 6's yet)
        if (this.scoreSplits.length < 2) return this.score;
        return this.score - this.scoreSplits[this.scoreSplits.length - 2];
    }

    get displaySplit() {
        if (this.scoreSplits.length === 0) return this.displayScore;
        return max(0, this.displayScore - this.scoreSplits[this.scoreSplits.length - 1]);
    }

    draw() {
        this.settled = true;
        let dt = deltaTime / 18;
        if (dt > 2) dt = 2;

        // Check if animation should be skipped
        let skipAnim = typeof settings !== 'undefined' && settings.disableAnimation;

        for (let i = 0; i < this.w; i++) {
            for (let j = 0; j < this.h; j++) {
                const box = this[i][j];
                const targetY = this.offsetY + S * (this.h - 1 - j);

                if (box.y < targetY || box.vy !== 0) {
                    if (skipAnim) {
                        // Skip animation: snap to target position
                        box.y = targetY;
                        box.vy = 0;
                    } else {
                        this.settled = false;
                        box.vy += gravity * dt;
                        box.y += box.vy * dt;

                        if (box.y >= targetY && box.vy > 0) {
                            box.y = targetY;
                            if (box.vy > 1) {
                                box.vy *= -bounceFactor;
                            } else {
                                box.vy = 0;
                            }
                        }
                    }
                }

                box.draw(i, j);
            }
        }
    }

    refill() {
        for (let i = 0; i < this.w; i++) {
            this[i] = this[i].filter((b) => b.n !== 0);
            let removedCount = this.h - this[i].length;

            if (!this.noRefill) {
                // Normal mode: drop new random tiles in from above
                for (let k = 0; k < removedCount; k++) {
                    const boxX = this.offsetX + S * i;
                    const boxY = this.offsetY - S * (k + 1);
                    this.state = (this.state * a + c) % m;
                    let n = floor((this.maxGen * this.state) / m) + 1;
                    this[i].push(new Box(n, boxX, boxY));
                }
            } else {
                // No-refill mode: pad with invisible n=0 placeholders at their settled positions
                let existingCount = this[i].length;
                for (let k = 0; k < removedCount; k++) {
                    const boxX = this.offsetX + S * i;
                    const boxY = this.offsetY + S * (this.h - 1 - (existingCount + k));
                    this[i].push(new Box(0, boxX, boxY));
                }
            }
        }
    }

    click(mx, my) {
        let [i, j] = this.getCoordinates(mx, my);
        if (!this?.[i]?.[j]) return;

        // Check if position is blocked by challenge mode
        if (typeof settings !== 'undefined') {
            if (settings.challengeMode === "bottomrow" && j === 0) return;
            if (settings.challengeMode === "middlecolumn" && i === 2) return;
        }

        let scoreGain = this.do(i, j);
        if (scoreGain) {
            if (this.noLegalMoves()) {
                this.gameOver = true;
                this.scoreSplitDiff = null;
                
                // Add final score to splits (if not already there from last 6)
                if (this.scoreSplits.length === 0 || this.scoreSplits[this.scoreSplits.length - 1] !== this.score) {
                    this.scoreSplits.push(this.score);
                }

                // Only save splits if this is a new daily record
                if (this.score > dailyBestScore) {
                    saveDailySplits(this.score, this.scoreSplits);
                }

                // Check achievements on game over (only for live games)
                if (!this.isReplaying) {
                    checkAchievements("game_over", { score: this.score });
                    // Update statistics
                    updateStatistics(this.score, this.largestChains);
                    // Update personal worst (only for natural game over)
                    updatePersonalWorst(this.score);
                    // Add to game history
                    addToGameHistory(this.score);
                    // Submit the score and, once the leaderboard reflects it,
                    // open it automatically. The finished board and its Review
                    // button stay underneath.
                    if (typeof submitGameOver === 'function') {
                        submitGameOver(this.score, this.seed, grid.moves.join(""));
                    } else {
                        saveHighScore(this.score, this.seed, grid.moves.join(""));
                    }
                }
            }
            // Save moves for both ongoing games and game over (to persist game over state)
            storeItem("autoSaveMoves", grid.moves.join(""));
            loop();
        }
    }

    do(i, j) {
        let box = this[i][j]
        let n = box.n;
        if (n === 0) return 0;
        if (n > 5) {
            // 6-tiles cannot be clicked/collapsed
            return 0;
        }

        let [chain, coords] = this.getChainWithCoords(i, j);
        if (chain.length < 2) return 0;

        // Track position usage (always, including during replay)
        this.positionHeatmap[i][j]++;

        this.moves.push(alphabet[5 * j + i]);
        let scoreGain = n * chain.length;
        this.score += scoreGain;

        // Track move times (only during live gameplay)
        if (!this.isReplaying) {
            let now = Date.now();
            if (this.firstMoveTime === null) {
                this.firstMoveTime = now;
                storeItem("autoSaveFirstMoveTime", now);
            }
            this.lastMoveTime = now;
            storeItem("autoSaveLastMoveTime", now);
        }

        // Track largest chain for this tile type (only during live gameplay)
        if (!this.isReplaying && chain.length > this.largestChains[n]) {
            this.largestChains[n] = chain.length;
        }

        // Check move-based achievements (only during live gameplay)
        if (!this.isReplaying) {
            checkAchievements("move_made", { scoreGain });
            // Update statistics live during gameplay
            updateStatisticsLive(this.score, this.largestChains);
        }

        chain.forEach(b => b.n = 0);

        box.n = n + 1;
        if (n + 1 == 4) this.maxGen = 4;

        this.scoreSplitDiff = null;

        if (n + 1 == 6) {
            this.polyominoList.push(coords);
            // Add current score to splits
            this.scoreSplits.push(this.score);
            
            // Calculate split diff against comparison splits
            if (typeof comparisonSplits !== 'undefined' && comparisonSplits && comparisonSplits.length > 0) {
                let splitIndex = this.scoreSplits.length - 1;
                let comparisonScore = splitIndex < comparisonSplits.length ? comparisonSplits[splitIndex] : comparisonSplits[comparisonSplits.length - 1];
                this.scoreSplitDiff = this.score - comparisonScore;
                // Set display time
                if (typeof splitDiffDisplayTime !== 'undefined') {
                    splitDiffDisplayTime = Date.now();
                }
            }
            box.shape = coords;
            box.split = this.split
            box.showShape = true;
            // Check shape achievements whenever a new shape is created (only during live gameplay)
            if (!this.isReplaying) {
                checkAchievements("shape_created", {});
                // Invalidate shape match cache
                if (typeof cachedShapeMatches !== 'undefined') {
                    cachedShapeMatches = null;
                }
            }
            // for (let i = 0; i < this.w; i ++) {
            //     for (let j = 0; j < this.h; j ++) {
            //         if (this[i][j].showShape) {
            //             box.showShape = true;
            //         }
            //     }
            // }
        }

        this.refill();
        return scoreGain;
    }

    getCoordinates(mx, my) {
        let i = floor((mx - this.offsetX) / S);
        let j = floor((my - this.offsetY) / S);
        return [i, this.h - 1 - j];
    }

    *getAdjacent(i, j) {
        for (let [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ]) {
            let b = this?.[i + dx]?.[j + dy];
            if (b) {
                yield [b, i + dx, j + dy];
            }
        }
    }

    getChainWithCoords(i, j) {
        let visited = new Set();
        let visitedCoords = [];
        let stack = [];

        stack.push([i, j]);
        visited.add(this[i][j]);
        visitedCoords.push([i, -j]);

        let n = this[i][j].n;
        while (stack.length) {
            [i, j] = stack.pop();
            for (let [b, bi, bj] of this.getAdjacent(i, j)) {
                if (b.n == n && !visited.has(b)) {
                    stack.push([bi, bj]);
                    visited.add(b);
                    visitedCoords.push([bi, -bj]);
                }
            }
        }

        return [[...visited], visitedCoords];
    }

    noLegalMoves() {
        // Get challenge mode setting (if available)
        let challengeMode = (typeof settings !== 'undefined') ? settings.challengeMode : "none";

        for (let i = 0; i < this.w; i++) {
            for (let j = 0; j < this.h; j++) {
                // Skip blocked positions based on challenge mode
                if (challengeMode === "bottomrow" && j === 0) continue;
                if (challengeMode === "middlecolumn" && i === 2) continue;

                if (this[i][j].n > 0 && this[i][j].n < 6 && this.getChainWithCoords(i, j)[0].length > 1) {
                    return false;
                }
            }
        }
        return true;
    }
}

// ============================================================================
// Game State
// ============================================================================

let grid;

// ============================================================================
// Game Functions
// ============================================================================

function newGame() {
    // Reload if new version is available
    if (typeof newVersionAvailable !== 'undefined' && newVersionAvailable) {
        console.log('Reloading to new version...');
        window.location.reload();
        return;
    }

    // Reset game over popup state
    if (typeof gameOverPopupPending !== 'undefined') {
        gameOverPopupPending = false;
        gameOverSettledTime = null;
    }

    // If there's an ongoing game (not already game over), count it as completed
    if (grid && !grid.gameOver && grid.moves.length > 0) {
        updateStatistics(grid.score, grid.largestChains);
        addToGameHistory(grid.score);
        // Save splits if this abandoned game beats daily best
        if (grid.score > dailyBestScore && grid.hasSplits) {
            saveDailySplits(grid.score, grid.scoreSplits);
        }
    }

    grid = new NumberGrid(w, h);
    storeItem("autoSaveSeed", grid.seed);
    removeItem("autoSaveMoves");
    removeItem("autoSaveFirstMoveTime");
    removeItem("autoSaveLastMoveTime");
    
    // Refetch comparison splits if needed (new day or score changed)
    checkAndRefetchComparisonSplits();
}

// ============================================================================
// Drawing Utilities
// ============================================================================

function drawShape(shape, centerX, centerY, cellSize, fillColor) {
    // 1. Determine the bounding box of the shape
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const [cx, cy] of shape) {
        minX = min(minX, cx);
        minY = min(minY, cy);
        maxX = max(maxX, cx);
        maxY = max(maxY, cy);
    }

    // 2. Calculate the shape's dimensions in cell units
    const cellWidth = maxX - minX + 1;
    const cellHeight = maxY - minY + 1;

    // 3. Calculate the total pixel width and height
    const pixelWidth = cellWidth * cellSize;
    const pixelHeight = cellHeight * cellSize;

    // 4. Calculate the top-left corner (starting point)
    const startX = centerX - Math.floor(pixelWidth / 2);
    const startY = centerY - Math.floor(pixelHeight / 2);

    // Draw settings
    push();
    noStroke();
    fill(fillColor);

    // 5. Iterate through the shape's cells and draw the squares with 1px margin
    for (const [cx, cy] of shape) {
        const xPos = startX + (cx - minX) * cellSize;
        const yPos = startY + (cy - minY) * cellSize;
        // Draw with 1px margin (inset by 1px, reduce size by 2px)
        rect(xPos + 1, yPos + 1, cellSize - 2, cellSize - 2);
    }

    pop();
}

function randomColor() {
    return color(random(255), random(255), random(255));
}
