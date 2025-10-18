const firebaseConfig = {
    apiKey: "AIzaSyAB8uHkJNm_8OtGGCO2f6g_3k2ehFsCzT0",
    authDomain: "collapse-700c3.firebaseapp.com",
    projectId: "collapse-700c3",
    storageBucket: "collapse-700c3.firebasestorage.app",
    messagingSenderId: "342963844921",
    appId: "1:342963844921:web:e2a44b32bfa71099d39ae8",
    measurementId: "G-W2Q5PLTER8"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let currentUser = null;
let currentUserDisplayName = null;

const alphabet = "abcdefghijklmnopqrstuvwxyz";

const tebahpla = {};

for (let i = 0; i < 26; i++) {
    tebahpla[alphabet[i]] = i;
}

const bounceFactor = 0.5;
const gravity = 1;

const m = 4294967296;
const a = 1664525;
const c = 1013904223;

const S = 80;
const X = 0;
const Y = 80;

const boxColors = {
    1: "#22baac",
    2: "#ffbe53",
    3: "#ee6984",
    4: "#4b6da4",
    5: "#845584",
    6: "#2c2c2c",
}

class Box {
    constructor(n, x, y) {
        Object.assign(this, { n, x, y, vy: 0 });
    }

    draw() {
        fill(boxColors[this.n % 10]);
        square(this.x, this.y, S);

        textSize(0.7 * S);
        let x = this.x + S * 0.5
        let y = this.y + S * 0.55
        if (this.n < 6) {
            fill(255);
            text(this.n, x, y);
        }

    }
}

class NumberGrid {
    constructor(w, h, seed = Date.now(), moves = "") {
        this.w = w;
        this.h = h;
        this.gameOver = false;
        this.score = 0;
        this.clicks = 0;
        this.settled = true;
        this.seed = seed;
        this.state = seed % m;
        this.moves = [];
        this.maxGen = 3
        for (let i = 0; i < this.w; i++) {
            this[i] = [];
            for (let j = 0; j < this.h; j++) {
                const boxX = X + S * i;
                const boxY = Y + S * (this.h - 1 - j);
                this[i].push(new Box(0, boxX, boxY));
            }
        }

        this.scoreSplits = []

        this.scoreSplitDiff = null

        this.refill();
        if (moves.length) {
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
            this.gameOver = this.noLegalMoves()
        }

        this.displayScore = this.score;
    }


    draw() {
        this.settled = true;
        let dt = deltaTime / 16.67;
        if (dt > 2) dt = 2
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
                removeItem("autoSaveSeed");
                removeItem("autoSaveMoves");
                saveHighScore(this.score, this.seed, grid.moves.join(""));
                
                // Only save splits if this is a new daily record
                if (this.score > dailyBestScore) {
                    saveDailySplits(this.score, this.scoreSplits);
                }
            } else {
                storeItem("autoSaveMoves", grid.moves.join(""));
            }
            loop();
        }
    }

    do(i, j) {
        let n = this[i][j].n;
        if (n > 5) return 0;
        let chain = this.getChain(i, j);
        if (chain.length < 2) return 0;
        this.moves.push(alphabet[5 * j + i]);
        let scoreGain = n * chain.length;
        this.score += scoreGain;

        this.clicks += 1;

        chain.forEach(b => b.n = 0)

        this[i][j].n = n + 1;
        if (n + 1 == 4) this.maxGen = 4
        this.scoreSplitDiff = null
        if (n + 1 == 6) {
            this.scoreSplits.push(this.score)
            if (splits.length) {
                this.scoreSplitDiff = this.score - (splits[this.scoreSplits.length - 1] || splits[splits.length - 1]);
            }
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

    getChain(i, j) {
        let visited = new Set();
        let visitedCoords = []
        let stack = [];
        stack.push([i, j]);
        visited.add(this[i][j]);
        visitedCoords.push([i, j])
        let n = this[i][j].n;
        while (stack.length) {
            [i, j] = stack.pop();
            for (let [b, bi, bj] of this.getAdjacent(i, j)) {
                if (b.n == n && !visited.has(b)) {
                    stack.push([bi, bj]);
                    visited.add(b);
                    visitedCoords.push([bi, bj])
                }
            }
        }
        return [...visited]
    }

    noLegalMoves() {
        for (let i = 0; i < this.w; i++) {
            for (let j = 0; j < this.h; j++) {
                if (this[i][j].n < 6 && this.getChain(i, j).length > 1) {
                    return false;
                }
            }
        }
        return true;
    }
}

function validateScore(seed, moves, score) {
    let g = new NumberGrid(5, 5, seed, moves)
    return (g.score === score)
}

let grid;

let highScore;

let w = 5;
let h = 5;

let topScores = [];
let showLeaderboard = false;
let showAllTime = false; // Toggle between daily and all-time scores

let splits
let dailyBestScore = 0; // Best score achieved today

function newGame() {
    grid = new NumberGrid(w, h);
    storeItem("autoSaveSeed", grid.seed);
    removeItem("autoSaveMoves");
}

function getTodayDateString() {
    const today = new Date();
    return `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
}

function loadDailySplits() {
    const savedData = getItem("dailySplits");
    if (!savedData) {
        splits = [];
        dailyBestScore = 0;
        return;
    }
    
    const { date, splits: savedSplits, score } = savedData;
    const today = getTodayDateString();
    
    if (date === today) {
        // Same day, load the splits
        splits = savedSplits || [];
        dailyBestScore = score || 0;
    } else {
        // Different day, discard old data
        splits = [];
        dailyBestScore = 0;
        removeItem("dailySplits");
    }
}

function saveDailySplits(score, scoreSplits) {
    const today = getTodayDateString();
    storeItem("dailySplits", {
        date: today,
        score: score,
        splits: scoreSplits
    });
    dailyBestScore = score;
    splits = scoreSplits;
    console.log("New daily record! Splits saved:", scoreSplits);
}

async function getOrCreateUserDocument(userId) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();

        if (!userDoc.exists) {
            // Create a new user document with a default display name
            const defaultName = `Player ${userId.substring(0, 6)}`;
            await db.collection('users').doc(userId).set({
                displayName: defaultName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            return defaultName;
        } else {
            return userDoc.data().displayName;
        }
    } catch (error) {
        console.error("Error getting/creating user document:", error);
        return `Player ${userId.substring(0, 6)}`;
    }
}

async function updateDisplayName(userId, newName) {
    try {
        await db.collection('users').doc(userId).update({
            displayName: newName,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        currentUserDisplayName = newName;
        console.log("Display name updated to:", newName);
        return true;
    } catch (error) {
        console.error("Error updating display name:", error);
        return false;
    }
}

async function promptForDisplayName() {
    const newName = prompt("Enter your display name:", currentUserDisplayName || "");
    if (newName && newName.trim() !== "") {
        const success = await updateDisplayName(currentUser.uid, newName.trim());
        if (success) {
            loop(); // Redraw if leaderboard is showing
        }
    }
}

async function saveHighScore(score, seed, moves) {
    if (!currentUser) {
        console.error("Cannot save score: user not signed in");
        return;
    }

    try {
        await db.collection('scores').add({
            userId: currentUser.uid,
            score: score,
            seed: seed,
            moves: moves,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        });
        console.log("Score saved successfully:", score);

        // Fetch and display the leaderboard after saving
        await fetchTodaysTopScores();
        showLeaderboard = true;
        loop(); // Redraw to show leaderboard
    } catch (error) {
        console.error("Error saving score:", error);
    }
}


async function fetchTodaysTopScores() {
    try {
        let snapshot;

        if (showAllTime) {
            // Fetch all-time scores
            snapshot = await db.collection('scores')
                .orderBy('score', 'desc')
                .get();
        } else {
            // Fetch today's scores
            const todayMidnight = new Date();
            todayMidnight.setUTCHours(0, 0, 0, 0);

            snapshot = await db.collection('scores')
                .where('timestamp', '>=', todayMidnight)
                .orderBy('timestamp', 'desc')
                .get();
        }

        // Group scores by user and keep only the highest for each
        const userBestScores = new Map();
        snapshot.forEach(doc => {
            const data = doc.data();
            const userId = data.userId;

            // Keep the highest score for each user
            if (!userBestScores.has(userId) || data.score > userBestScores.get(userId).score) {
                userBestScores.set(userId, data);
            }
        });

        // Fetch display names for all users
        const userIds = Array.from(userBestScores.keys());
        const userDocs = await Promise.all(
            userIds.map(uid => db.collection('users').doc(uid).get())
        );

        // Merge display names with scores
        let scoresWithNames = userIds.map((userId, index) => {
            const scoreData = userBestScores.get(userId);
            const userDoc = userDocs[index];
            return {
                ...scoreData,
                displayName: userDoc.exists ? userDoc.data().displayName : `Player ${userId.substring(0, 6)}`,
            };
        });

        // Now deduplicate by display name, keeping highest score for each name
        const nameBestScores = new Map();
        scoresWithNames.forEach(score => {
            const name = score.displayName;
            if (!nameBestScores.has(name) || score.score > nameBestScores.get(name).score) {
                nameBestScores.set(name, score);
            }
        });

        // Convert to array, sort by score descending, and take top 10
        topScores = Array.from(nameBestScores.values());
        topScores.sort((a, b) => b.score - a.score);
        topScores = topScores.slice(0, 10);

        console.log("Top scores fetched:", topScores);
        redraw()
    } catch (error) {
        console.error("Error fetching top scores:", error);
    }
}

function setup() {
    createCanvas(w * S, h * S + S);
    textAlign(CENTER, CENTER);
    strokeWeight(2);

    auth.onAuthStateChanged(async user => {
        if (user) {
            // User is signed in.
            currentUser = user;
            console.log("User signed in anonymously:", currentUser.uid);

            // Load or create user's display name
            currentUserDisplayName = await getOrCreateUserDocument(user.uid);
            console.log("Display name:", currentUserDisplayName);
        } else {
            // User is signed out.
            currentUser = null;
            currentUserDisplayName = null;
            auth.signInAnonymously().catch(error => {
                console.error("Anonymous sign-in failed:", error);
            });
        }
    });

    loadDailySplits();

    let autoSaveSeed = getItem("autoSaveSeed");
    if (autoSaveSeed !== null) {
        let moves = getItem("autoSaveMoves") || "";
        grid = new NumberGrid(
            w,
            h,
            autoSaveSeed,
            moves.split("")
        );
    } else {
        newGame();
    }

}

function draw() {
    background(220);
    grid.draw();
    let over = grid.gameOver && grid.settled;
    fill(over ? "black" : "white");
    rect(0, 0, width, 80);
    fill(over ? "white" : "black");
    if (grid.displayScore < grid.score) {
        grid.displayScore++;
    }

    textSize(36);
    text(grid.displayScore, width / 2, 42);
    text("↺", width - S / 2, 42);

    if (grid.scoreSplitDiff !== null) {
        let sign;
        let textColor;
        if (grid.scoreSplitDiff < 0) {
            sign = "";
            textColor = "red";
        } else if (grid.scoreSplitDiff === 0) {
            sign = "=";
            textColor = "gray";
        } else {
            sign = "+";
            textColor = "blue";
        }
        fill(textColor);
        textSize(16);
        text("(" + sign + grid.scoreSplitDiff + ")", width / 2, S - 14);
    }
    textSize(32);
    // Draw leaderboard toggle button (top left)
    text("🏆", S / 2, 42);

    // Draw leaderboard if toggled on
    if (showLeaderboard) {
        drawLeaderboard();
    }

    //   fill(200);
    //   textSize(15);
    //   text(frameCount, 20, 10);

    if (grid.settled && grid.displayScore == grid.score)
        noLoop();

}

function drawLeaderboard() {
    // Semi-transparent background
    fill(0, 0, 0, 200);
    rect(20, 100, width - 40, height - 120);

    // Title
    fill(255);
    textSize(24);
    textAlign(CENTER, CENTER);
    text(showAllTime ? "All-Time Top 10" : "Today's Top 10", width / 2, 130);

    // Edit name button (top right of leaderboard)
    textSize(20);
    textAlign(RIGHT, CENTER);
    text("✏️", width - 40, 130);

    // Toggle button (top left of leaderboard)
    textAlign(LEFT, CENTER);
    text(showAllTime ? "📅" : "🌍", 40, 130);

    textAlign(CENTER, CENTER);
    textSize(24);
    textAlign(RIGHT, CENTER);
    text("✏️", width - 40, 130);
    textAlign(CENTER, CENTER);
    textSize(24);

    if (topScores.length === 0) {
        // Show loading message
        textSize(18);
        fill(200);
        text("Fetching scores...", width / 2, height / 2);
    } else {
        // Scores
        textSize(16);
        textAlign(LEFT, CENTER);
        let y = 170;
        for (let i = 0; i < topScores.length; i++) {
            let scoreData = topScores[i];
            let displayText = `${i + 1}. ${scoreData.score}`;

            if (scoreData.displayName) {
                displayText += ` (${scoreData.displayName})`
            }

            // Highlight current user's score
            if (scoreData.userId === currentUser?.uid) {
                fill(255, 255, 0); // Yellow for current user
            } else {
                fill(255);
            }

            text(displayText, 40, y);
            y += 25;
        }
    }

    textAlign(CENTER, CENTER); // Reset alignment
}

function mousePressed() {
    if (mouseY < 80) {
        if (mouseX > width - 80) {
            // Reset button (top right)
            if (grid.gameOver || grid.score < 1000 || confirm("Start a new game?")) {
                newGame();
                showLeaderboard = false;
                loop();
            }
        } else if (mouseX < 80) {
            // Leaderboard toggle button (top left)
            showLeaderboard = !showLeaderboard;

            // Always fetch fresh scores when showing the leaderboard
            if (showLeaderboard) {
                fetchTodaysTopScores().then(() => {
                    loop(); // Redraw once scores are loaded
                });
            }

            loop(); // Redraw to show/hide leaderboard immediately
        }
    } else {
        if (showLeaderboard) {
            // Check if clicking the edit name button in leaderboard (top right area)
            if (mouseY >= 100 && mouseY <= 160 && mouseX >= width - 80 && mouseX <= width - 20) {
                promptForDisplayName();
            } else if (mouseY >= 100 && mouseY <= 160 && mouseX >= 20 && mouseX <= 80) {
                // Toggle between daily and all-time (top left of leaderboard)
                showAllTime = !showAllTime;
                topScores = []; // Clear scores to show loading message
                fetchTodaysTopScores().then(() => {
                    loop(); // Redraw once scores are loaded
                });
                loop(); // Redraw immediately to show loading
            } else {
                // Clicking elsewhere on leaderboard closes it
                showLeaderboard = false
            }
        } else {
            grid.click(mouseX, mouseY);
        }
    }
    redraw();
}
