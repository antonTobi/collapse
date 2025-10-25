// ============================================================================
// Box Class
// ============================================================================

class Box {
    constructor(n, x, y) {
        Object.assign(this, { n, x, y, vy: 0 });
    }

    draw() {
        if (this.y < 1) return;
        fill(boxColors[this.n]);
        noStroke();
        square(this.x + 1, this.y + 1, S - 2);

        textSize(0.7 * S);
        let x = this.x + S * 0.5;
        let y = this.y + S * 0.5;
        if (this.n < 6) {
            fill(255, 230);
            noStroke();
            text(this.n, x, y + 0.05 * S);
        } else {
            drawShape(this.shape, x, y, 12, 200);
        }
    }
}

// ============================================================================
// NumberGrid Class
// ============================================================================

class NumberGrid {
    constructor(w, h, seed = Date.now(), moves = "") {
        this.w = w;
        this.h = h;
        this.score = 0;
        this.settled = true;
        this.seed = seed;
        this.state = seed % m;
        this.moves = [];
        this.maxGen = 3;

        for (let i = 0; i < this.w; i++) {
            this[i] = [];
            for (let j = 0; j < this.h; j++) {
                const boxX = X + S * i;
                const boxY = Y + S * (this.h - 1 - j);
                this[i].push(new Box(0, boxX, boxY));
            }
        }

        this.scoreSplits = [];
        this.scoreSplitDiff = null;
        this.polyominoList = [];
        this.isReplaying = false;

        this.refill();

        if (moves.length) {
            this.isReplaying = true;
            let tic = performance.now();
            for (let c of moves) {
                let k = tebahpla[c];
                let i = k % 5;
                let j = (k - i) / 5;
                this.do(i, j);
            }

            for (let i = 0; i < this.w; i++) {
                for (let j = 0; j < this.h; j++) {
                    let box = this[i][j];
                    box.y = Y + S * (this.h - 1 - j);
                    box.vy = 0;
                }
            }

            let toc = performance.now();

            console.log(`Replayed ${moves.length} moves in ${toc - tic} ms`);
            this.isReplaying = false;
        }
        this.gameOver = this.noLegalMoves();
        this.displayScore = this.score;
    }

    draw() {
        this.settled = true;
        let dt = deltaTime / 18;
        if (dt > 2) dt = 2;

        for (let i = 0; i < this.w; i++) {
            for (let j = 0; j < this.h; j++) {
                const box = this[i][j];
                const targetY = Y + S * (this.h - 1 - j);

                if (box.y < targetY || box.vy !== 0) {
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

                box.draw();
            }
        }
    }

    refill() {
        for (let i = 0; i < this.w; i++) {
            this[i] = this[i].filter((b) => b.n !== 0);
            let removedCount = this.h - this[i].length;

            for (let k = 0; k < removedCount; k++) {
                const boxX = X + S * i;
                const boxY = Y - S * (k + 1);
                this.state = (this.state * a + c) % m;
                let n = floor((this.maxGen * this.state) / m) + 1;
                this[i].push(new Box(n, boxX, boxY));
            }
        }
    }

    click(mx, my) {
        let [i, j] = this.getCoordinates(mx, my);
        if (!this?.[i]?.[j]) return;

        let scoreGain = this.do(i, j);
        if (scoreGain) {
            if (this.noLegalMoves()) {
                this.gameOver = true;
                this.scoreSplitDiff = null;
                removeItem("autoSaveSeed");
                removeItem("autoSaveMoves");
                saveHighScore(this.score, this.seed, grid.moves.join(""));

                // Only save splits if this is a new daily record
                if (this.score > dailyBestScore) {
                    saveDailySplits(this.score, this.scoreSplits);
                }

                // Check achievements on game over (only for live games)
                if (!this.isReplaying) {
                    checkAchievements("game_over", { score: this.score });
                }
            } else {
                storeItem("autoSaveMoves", grid.moves.join(""));
            }
            loop();
        }
    }

    do(i, j) {
        let box = this[i][j]
        let n = box.n;
        if (n > 5) {
            box.showShape = !(box.showShape)
            return 0;
        }

        let [chain, coords] = this.getChainWithCoords(i, j);
        if (chain.length < 2) return 0;

        this.moves.push(alphabet[5 * j + i]);
        let scoreGain = n * chain.length;
        this.score += scoreGain;

        // Check move-based achievements (only during live gameplay)
        if (!this.isReplaying) {
            checkAchievements("move_made", { scoreGain });
        }

        chain.forEach(b => b.n = 0);

        box.n = n + 1;
        if (n + 1 == 4) this.maxGen = 4;

        this.scoreSplitDiff = null;





        if (n + 1 == 6) {
            this.polyominoList.push(coords);
            // Check shape achievements whenever a new shape is created (only during live gameplay)
            if (!this.isReplaying) {
                checkAchievements("shape_created", {});
                // Invalidate shape match cache
                if (typeof cachedShapeMatches !== 'undefined') {
                    cachedShapeMatches = null;
                }
            }
            this.scoreSplits.push(this.score);
            if (splits.length) {
                this.scoreSplitDiff = this.score - (splits[this.scoreSplits.length - 1] || splits[splits.length - 1]);
            }
            box.shape = coords;
            box.showShape = true;
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
        let i = floor((mx - X) / S);
        let j = floor((my - Y) / S);
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
        for (let i = 0; i < this.w; i++) {
            for (let j = 0; j < this.h; j++) {
                if (this[i][j].n < 6 && this.getChainWithCoords(i, j)[0].length > 1) {
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
let highScore;
let w = 5;
let h = 5;

// ============================================================================
// Game Functions
// ============================================================================

function newGame() {
    // Reload if new version is available
    if (typeof newVersionAvailable !== 'undefined' && newVersionAvailable) {
        console.log('Reloading to new version...');
        window.location.reload(true);
        return;
    }
    
    grid = new NumberGrid(w, h);
    storeItem("autoSaveSeed", grid.seed);
    removeItem("autoSaveMoves");
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
