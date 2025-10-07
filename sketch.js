const autoSaveKey = "autoSave";
const audioPreference = "audioPreference";
const scoreSplitsKey = "numberCollapseScoreSplits";
const highScoreKey = "numberCollapseHighScore";

const alphabet = "abcdefghijklmnopqrstuvwxyz";

// things to add:
// more animation effects
// sound effects
// ability to have a "fixed" box (with no number and no gravity) in the center
// achievements
// multiple game modes (a main menu to select different board sizes etc)
// game timer

// store splits and highscore in the game object

// highscores, boxChoices 1-4
// 3x3 (1-4), score: 755, tile: 8
// 4x4 (1-4), score: 5366, tile: 11
// 4x5 (1-4), score: 10415, tile: 12
// 5x5 (1-4), score: 16410, tile: 12

// 3x3 (1-3), score: 892, tile: 8

// 5x5 (1-5), score: 4881, tile: 11

const bounceFactor = 0.5;
const gravity = 1;

let showNumbers = false

let showDigits = true

let keepLooping = false

const boxColors = [
    "#555555",
    "#22baac",
    "#ffbe53",
    "#ee6984",
    "#4b6da4",
    "#845584",
    "#4B698C",
    "#418A8C",
    "#AD417B",
    "#F6954A",
];

class MCG {
    static parameters = [
        [2 ** 35 - 31, 200105],
        [2 ** 34 - 41, 102311],
        [2 ** 33 - 9, 340416],
        [2 ** 32 - 5, 657618],
        [2 ** 31 - 1, 950975]
    ]

    static array(n, seed = Date.now()) {
        return Array.from({ length: n }, (_, i) => new this(...this.parameters[i], seed));
    }

    constructor(m, a, seed = Date.now()) {
        this.m = m
        this.a = a
        this.seed = (seed % (this.m - 1)) + 1;
    }

    next() {
        this.seed = (this.a * this.seed) % this.m;
        return this.seed / this.m;
    }

    from(arr) {
        if (arguments.length > 1) {
            arr = arguments;
        }
        let index = Math.floor(this.next() * arr.length);
        return arr[index];
    }

    int(min, max) {
        if (max === undefined) {
            max = min - 1;
            min = 0;
        }
        return Math.floor(this.next() * (max - min + 1)) + min;
    }

    float(min, max) {
        if (max === undefined) {
            max = min;
            min = 0;
        }
        return this.next() * (max - min) + min;
    }
}

class Box {
    constructor(n, x, y) {
        this.n = n;
        this.x = x;
        this.y = y;
        this.vy = 0;
        this.locked = false;
        this.score = 0;
    }

    draw() {
        fill(this.locked ? 70 : boxColors[this.n % 10]);
        square(this.x, this.y, s);
        if (showDigits && !this.locked) {
            textSize(0.7 * s);

            let yFactor = 0.55;
            let xFactor = this.n > 9 ? 0.48 : 0.5;
            let x = this.x + s * xFactor
            let y = this.y + s * yFactor
            fill(255);
            text(this.n, x, y);
        }
        if (showNumbers && this.n == 5 && this.score > 0) {
            push()
            fill("white")
            textSize(0.15 * s);
            textAlign(RIGHT, CENTER)
            text(this.score, this.x + 0.95 * s, this.y + s * 0.9);
            pop()
        }
    }
}

class NumberGrid {
    constructor(w, h, seed = Date.now()) {
        this.w = w;
        this.h = h;
        this.seed = seed;
        this.settled = false;
        this.maxSpawn = 4;
        this.cap = 5; // undefined for no cap
        this.minChainSize = 2;
        this.increment = 1;
        this.gameOver = false;
        this.score = 0;
        this.clicks = 0;
        this.displayScore = 0;
        this.splits = [];
        this.generators = MCG.array(w, seed);
        this.moveHistory = [];

        do {

            for (let i = 0; i < this.w; i++) {
                this[i] = [];
                for (let j = 0; j < this.h; j++) {
                    const boxX = s * i;
                    const boxY = s * (this.h - 1 - j);
                    let n = this.generators[i].int(1, this.maxSpawn)
                    this[i].push(new Box(n, boxX, boxY));
                }
            }
        }
        while (this.noLegalMoves());
    }

    toObj() {
        let out = {};
        for (let i = 0; i < this.w; i++) {
            out[i] = {};
            for (let j = 0; j < this.h; j++) {
                out[i][j] = this[i][j].n;
            }
        }
        out.score = this.score;
        out.clicks = this.clicks;
        out.splits = this.splits;
        return out;
    }

    load(obj) {
        for (let i = 0; i < this.w; i++) {
            for (let j = 0; j < this.h; j++) {
                this[i][j].n = obj[i][j];
                if (this[i][j].n > this.cap) {
                    this[i][j].locked = true;
                }
            }
        }
        this.score = obj.score;
        this.clicks = obj.clicks;
        this.splits = obj.splits;
        this.displayScore = this.score;
        if (this.noLegalMoves()) {
            this.gameOver = true;
        }
    }

    draw() {
        this.settled = true;
        for (let i = 0; i < this.w; i++) {
            for (let j = 0; j < this.h; j++) {
                const box = this[i][j];
                const targetY = s * (this.h - 1 - j);

                // Update physics only if the box is not settled
                if (box.y < targetY || box.vy !== 0) {
                    this.settled = false;
                    box.vy += gravity;
                    box.y += box.vy;

                    // Check for collision with the "floor" (targetY)
                    // The "vy > 0" check ensures we only trigger this on the way down
                    if (box.y >= targetY && box.vy > 0) {
                        box.y = targetY; // Snap to the floor to prevent sinking

                        // If moving fast enough, bounce. Otherwise, settle.
                        if (box.vy > 1) {
                            // Stop bouncing if velocity is very low
                            box.vy *= -bounceFactor; // Reverse and dampen velocity
                            // clackSound.play()
                        } else {
                            box.vy = 0; // Come to a complete stop
                        }
                    }
                }

                box.draw();
            }
        }
    }

    applyGravityAndRefill() {
        for (let i = 0; i < this.w; i++) {
            let remainingBoxes = this[i].filter((b) => b.n !== 0);
            let removedCount = this.h - remainingBoxes.length;

            let newBoxes = [];
            for (let k = 0; k < removedCount; k++) {
                const boxX = s * i;
                const boxY = -s * (k + 1);
                let n = this.generators[i].int(1, this.maxSpawn)
                newBoxes.push(new Box(n, boxX, boxY));
            }

            this[i] = remainingBoxes.concat(newBoxes);
        }
    }

    click(i, j) {
        if (!this?.[i]?.[j]) return;
        if (this[i][j].locked) return;
        let n = this[i][j].n;
        let chain = this.getChain(i, j);
        if (chain.length < this.minChainSize) return;
        this.moveHistory.push(alphabet[this.w*i + j]);
        if (playSound) {
            // popSound.play();
        }

        this.score += n * chain.length;
        this[i][j].score += n * chain.length;
        this.clicks += 1;

        for (let b of chain) {
            if (b == this[i][j]) continue
            this[i][j].score += b.score;
            b.n = 0;
        }



        this[i][j].n = n + this.increment;

        if (this[i][j].n > this.cap) {
            this[i][j].locked = true;
            let k = this.splits.length;
            this.splits.push(this.score);
            if (scoreSplits[k]) {
                scoreSplitDiff = this.score - scoreSplits[k];
                scoreSplitOpacity = 10;
            }
        }

        this.applyGravityAndRefill();

        if (this.noLegalMoves()) {
            this.gameOver = true;
            if (this.score > highScore) {
                // highScore = this.score;
                storeItem(highScoreKey, highScore);
                scoreSplits = this.splits;
                storeItem(scoreSplitsKey, this.splits);
            }
        }

        loop()
    }

    reset() {
        if (this.score > highScore) {
            highScore = this.score;
            storeItem(highScoreKey, highScore);
            scoreSplits = this.splits;
            storeItem(scoreSplitsKey, this.splits);
        }
        this.gameOver = false;
        this.score = 0;
        this.clicks = 0;
        this.displayScore = 0;
        this.splits = [];
        scoreSplitOpacity = 0;
        do {
            for (let i = 0; i < this.w; i++) {
                for (let j = 0; j < this.h; j++) {
                    this[i][j].n = 0;
                }
            }
            this.applyGravityAndRefill();
        } while (this.noLegalMoves());
        loop()
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

    getChain(i, j) {
        let visited = new Set();
        let stack = [];
        stack.push([i, j]);
        visited.add(this[i][j]);
        let n = this[i][j].n;
        while (stack.length) {
            [i, j] = stack.pop();
            for (let [b, bi, bj] of this.getAdjacent(i, j)) {
                if (b.n == n && !visited.has(b)) {
                    stack.push([bi, bj]);
                    visited.add(b);
                }
            }
        }
        return [...visited];
    }

    noLegalMoves() {
        for (let i = 0; i < this.w; i++) {
            for (let j = 0; j < this.h; j++) {
                if (this[i][j].locked) continue;
                if (this.getChain(i, j).length > 1) {
                    return false;
                }
            }
        }
        return true;
    }
}


let grid;

let playSound;

let scoreSplits;

let scoreSplitDiff;

let scoreSplitOpacity = 0;

let highScore;

const w = 5;
const h = 5;

let s = 80;

function setup() {

    createCanvas(w * s, h * s + s);
    textAlign(CENTER, CENTER);
    strokeWeight(2);
    grid = new NumberGrid(w, h);
    let autoSave = getItem(autoSaveKey);
    if (autoSave) {
        grid.load(autoSave);
    }

    playSound = getItem(audioPreference);
    if (playSound === null) {
        playSound = true;
    }

    scoreSplits = getItem(scoreSplitsKey);
    if (scoreSplits === null) {
        scoreSplits = [];
    }

    highScore = getItem(highScoreKey);
    if (highScore === null) {
        highScore = 0;
    }
}

function draw() {
    keepLooping = false
    background(220);
    push()
    translate(0, s);
    grid.draw();
    pop()
    let over = grid.gameOver;
    fill(over ? "black" : "white");
    rect(0, 0, width, s);
    fill(over ? "white" : "black");
    textSize(42);
    if (grid.displayScore + 1000 <= grid.score) grid.displayScore = grid.score;
    // if (grid.displayScore + 10 <= grid.score ) grid.displayScore += 10
    if (grid.displayScore < grid.score) {
        grid.displayScore++;
        // popSound.play()
    }
    //text(grid.clicks, width / 2, 27)
    textSize(36);
    text(grid.displayScore, width / 2, 42);

    textSize(42);
    text("↺", width - s / 2, 42);
    // textSize(30);
    // text(playSound ? "🔊" : "🔈", s / 2, 42);

    textSize(15);

    if (highScore) text(highScore, width / 2, 14);

    // text(scoreSplitOpacity.toFixed(2), width/2, grid.s - 14)
    scoreSplitOpacity -= 0.05;
    if (scoreSplitOpacity > 0) {
        keepLooping = true
        let sign;
        let textColor;
        if (scoreSplitDiff < 0) {
            sign = "";
            textColor = "red";
        } else if (scoreSplitDiff === 0) {
            sign = "=";
            textColor = "gray";
        } else {
            sign = "+";
            textColor = "blue";
        }
        textColor = color(textColor)
        textColor.setAlpha(map(scoreSplitOpacity, 0, 1, 0, 255, true))
        fill(textColor);
        text("(" + sign + scoreSplitDiff + ")", width / 2, s - 14);
    }

    // text(frameCount, 20, 10)

    // text(round(frameRate()/10)*10, 20, 20)

    if (grid.settled && grid.displayScore == grid.score && scoreSplitOpacity < 0) {
        // console.log("STOP", frameCount)
        noLoop()
    }

    // if (!keepLooping) {noLoop()}
}

function mousePressed() {
    if (mouseY < s) {
        if (mouseX < s) {
            playSound = !playSound;
            storeItem(audioPreference, playSound);
        } else if (mouseX < 2 * s) {
            showNumbers = !showNumbers
        } else if (mouseX < 4 * s) {
            //       showDigits = !showDigits
        } else if (mouseX > width - 80) {
            if (grid.gameOver || grid.score == 0 || confirm("Start a new game?")) {
                // grid = new NumberGrid(w, h, 0, s, w * s, h * s + s);
                grid.reset();
                storeItem(autoSaveKey, grid.toObj());
                // grid.load(getItem(saveGameKey))
            }
        }
    } else {
        let i = floor((mouseX) / s);
        let j = h - 1 - floor((mouseY - s) / s);
        grid.click(i, j);
        storeItem(autoSaveKey, grid.toObj());
    }
    redraw()
}

function testStore() {
    storeItem("...", grid);
    console.log(getItem("..."));
}
