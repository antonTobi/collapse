// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// User State
let currentUser = null;
let currentUserDisplayName = null;

// Leaderboard State
let topScoresDaily = [];
let topScoresAllTime = [];
let topScoresYesterday = [];
let showLeaderboard = false;
let showAllTime = false;
let isLoadingScores = false;

// Global Statistics State
let globalStats = {
    gamesToday: 0,
    activeUsersToday: 0,
    allTimeGames: 0,
    isLoading: false
};

// Daily Splits State
let splits = []; // Simple array: [score@6, score@6, ..., finalScore]
let dailyBestScore = 0;

// Comparison Splits State
let comparisonSplits = null; // Loaded splits to compare against
let comparisonSplitsLoading = false; // Loading state
let comparisonScores = {
    pb: null,
    dailypb: null,
    wr: null,
    dailywr: null
};
let lastComparisonFetchDate = null; // Track date to detect day change

// ============================================================================
// Date Utilities
// ============================================================================

function getTodayDateString() {
    const today = new Date();
    return `${today.getUTCFullYear()}-${today.getUTCMonth() + 1}-${today.getUTCDate()}`;
}

function getYesterdayDateString() {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return `${yesterday.getUTCFullYear()}-${yesterday.getUTCMonth() + 1}-${yesterday.getUTCDate()}`;
}

// ============================================================================
// Daily Splits Management
// ============================================================================

function loadDailySplits() {
    const savedData = getItem("dailySplits");
    if (!savedData) {
        splits = []; // Empty array for new day
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

// ============================================================================
// Comparison Splits Fetching
// ============================================================================

/**
 * Replay a game to extract its splits (scores at each 6 creation, plus final score)
 * @param {number} seed - The game seed
 * @param {string} moves - The moves string
 * @returns {Array} - Simple array of scores [score@6, score@6, ..., finalScore]
 */
function replayGameForSplits(seed, moves) {
    // Create a temporary grid to replay the game
    let state = seed % m;
    let score = 0;
    let maxGen = 3;
    let scoreSplits = [];
    
    // Initialize grid state
    let gridState = [];
    for (let i = 0; i < w; i++) {
        gridState[i] = [];
        for (let j = 0; j < h; j++) {
            gridState[i][j] = 0;
        }
    }
    
    // Fill initial grid
    for (let i = 0; i < w; i++) {
        for (let j = 0; j < h; j++) {
            state = (state * a + c) % m;
            gridState[i][j] = Math.floor((maxGen * state) / m) + 1;
        }
    }
    
    // Replay each move
    for (let moveChar of moves) {
        let k = tebahpla[moveChar];
        if (k === undefined) continue;
        
        let mi = k % 5;
        let mj = Math.floor(k / 5);
        
        let n = gridState[mi][mj];
        if (n === 0 || n > 5) continue;
        
        // Get chain at position
        let chain = getChainAt(gridState, mi, mj, n);
        if (chain.length < 2) continue;
        
        // Calculate score gain
        let scoreGain = n * chain.length;
        score += scoreGain;
        
        // Clear chain cells
        for (let [ci, cj] of chain) {
            gridState[ci][cj] = 0;
        }
        
        // Upgrade clicked cell
        gridState[mi][mj] = n + 1;
        if (n + 1 === 4) maxGen = 4;
        
        // Track splits only for 6's
        if (n + 1 === 6) {
            scoreSplits.push(score);
        }
        
        // Refill grid (simulate gravity and new tiles)
        for (let i = 0; i < w; i++) {
            // Remove zeros (gravity)
            gridState[i] = gridState[i].filter(v => v !== 0);
            // Add new tiles from top
            let removedCount = h - gridState[i].length;
            for (let k = 0; k < removedCount; k++) {
                state = (state * a + c) % m;
                gridState[i].push(Math.floor((maxGen * state) / m) + 1);
            }
        }
    }
    
    // Add final score to splits
    if (scoreSplits.length === 0 || scoreSplits[scoreSplits.length - 1] !== score) {
        scoreSplits.push(score);
    }
    
    return scoreSplits;
}

/**
 * Get chain of matching tiles at position (flood fill)
 */
function getChainAt(grid, i, j, n) {
    let chain = [];
    let visited = new Set();
    let stack = [[i, j]];
    
    while (stack.length > 0) {
        let [ci, cj] = stack.pop();
        let key = `${ci},${cj}`;
        
        if (visited.has(key)) continue;
        if (ci < 0 || ci >= w || cj < 0 || cj >= h) continue;
        if (grid[ci][cj] !== n) continue;
        
        visited.add(key);
        chain.push([ci, cj]);
        
        stack.push([ci - 1, cj]);
        stack.push([ci + 1, cj]);
        stack.push([ci, cj - 1]);
        stack.push([ci, cj + 1]);
    }
    
    return chain;
}

/**
 * Fetch comparison splits based on the current setting
 * @param {string} compareType - "nothing", "pb", "dailypb", "wr", "dailywr"
 * @param {boolean} forceRefetch - Force refetch even if cached
 */
async function fetchComparisonSplits(compareType, forceRefetch = false) {
    if (compareType === "nothing") {
        comparisonSplits = null;
        console.log("Comparison splits disabled");
        return;
    }
    
    comparisonSplitsLoading = true;
    lastComparisonFetchDate = getTodayDateString();
    
    try {
        let gameData = null;
        
        if (compareType === "pb") {
            // Fetch user's personal best (all-time)
            if (!currentUser) {
                console.log("No user signed in, cannot fetch PB");
                comparisonSplits = null;
                comparisonSplitsLoading = false;
                return;
            }
            const doc = await db.collection('highscores').doc(currentUser.uid).get();
            if (doc.exists) {
                gameData = doc.data();
            }
        } else if (compareType === "dailypb") {
            // Fetch user's daily personal best
            if (!currentUser) {
                console.log("No user signed in, cannot fetch daily PB");
                comparisonSplits = null;
                comparisonSplitsLoading = false;
                return;
            }
            const today = getTodayDateString();
            const doc = await db.collection('dailyhighscores').doc(today).collection('scores').doc(currentUser.uid).get();
            if (doc.exists) {
                gameData = doc.data();
            }
        } else if (compareType === "wr") {
            // Fetch world record (all-time)
            const snapshot = await db.collection('highscores')
                .orderBy('score', 'desc')
                .limit(1)
                .get();
            if (!snapshot.empty) {
                gameData = snapshot.docs[0].data();
            }
        } else if (compareType === "dailywr") {
            // Fetch daily world record
            const today = getTodayDateString();
            const snapshot = await db.collection('dailyhighscores').doc(today).collection('scores')
                .orderBy('score', 'desc')
                .limit(1)
                .get();
            if (!snapshot.empty) {
                gameData = snapshot.docs[0].data();
            }
        }
        
        // Update cached score
        const newScore = gameData?.score || null;
        const oldScore = comparisonScores[compareType];
        comparisonScores[compareType] = newScore;
        
        if (gameData && gameData.seed && gameData.moves) {
            // Only recalculate splits if score changed or forced
            if (forceRefetch || oldScore !== newScore || comparisonSplits === null) {
                comparisonSplits = replayGameForSplits(gameData.seed, gameData.moves);
                console.log(`Loaded ${compareType} splits (score: ${gameData.score}):`, comparisonSplits);
            }
        } else {
            comparisonSplits = null;
            console.log(`No ${compareType} game data found`);
        }
    } catch (error) {
        console.error("Error fetching comparison splits:", error);
        comparisonSplits = null;
    }
    
    comparisonSplitsLoading = false;
}

/**
 * Fetch all comparison scores for display in settings (without calculating splits)
 */
async function fetchAllComparisonScores() {
    const today = getTodayDateString();
    
    try {
        // Fetch PB
        if (currentUser) {
            const pbDoc = await db.collection('highscores').doc(currentUser.uid).get();
            comparisonScores.pb = pbDoc.exists ? pbDoc.data().score : null;
            
            const dailyPbDoc = await db.collection('dailyhighscores').doc(today).collection('scores').doc(currentUser.uid).get();
            comparisonScores.dailypb = dailyPbDoc.exists ? dailyPbDoc.data().score : null;
        }
        
        // Fetch WR
        const wrSnapshot = await db.collection('highscores')
            .orderBy('score', 'desc')
            .limit(1)
            .get();
        comparisonScores.wr = !wrSnapshot.empty ? wrSnapshot.docs[0].data().score : null;
        
        // Fetch Daily WR
        const dailyWrSnapshot = await db.collection('dailyhighscores').doc(today).collection('scores')
            .orderBy('score', 'desc')
            .limit(1)
            .get();
        comparisonScores.dailywr = !dailyWrSnapshot.empty ? dailyWrSnapshot.docs[0].data().score : null;
        
        lastComparisonFetchDate = today;
        loop(); // Trigger redraw to show updated scores
    } catch (error) {
        console.error("Error fetching comparison scores:", error);
    }
}

/**
 * Check if comparison splits need refetching (new day or score changed)
 * Called on new game start
 */
async function checkAndRefetchComparisonSplits() {
    const compareType = settings.compareSplits;
    if (compareType === "nothing") return;
    
    const today = getTodayDateString();
    const isNewDay = lastComparisonFetchDate !== today;
    
    // Refetch if it's a new day (daily scores reset) or if we haven't fetched yet
    if (isNewDay || comparisonSplits === null) {
        console.log("Refetching comparison splits:", isNewDay ? "new day" : "no cached splits");
        await fetchComparisonSplits(compareType, true);
    } else {
        // Check if score changed by fetching current score
        let currentScore = null;
        try {
            if (compareType === "pb" && currentUser) {
                const doc = await db.collection('highscores').doc(currentUser.uid).get();
                currentScore = doc.exists ? doc.data().score : null;
            } else if (compareType === "dailypb" && currentUser) {
                const doc = await db.collection('dailyhighscores').doc(today).collection('scores').doc(currentUser.uid).get();
                currentScore = doc.exists ? doc.data().score : null;
            } else if (compareType === "wr") {
                const snapshot = await db.collection('highscores').orderBy('score', 'desc').limit(1).get();
                currentScore = !snapshot.empty ? snapshot.docs[0].data().score : null;
            } else if (compareType === "dailywr") {
                const snapshot = await db.collection('dailyhighscores').doc(today).collection('scores').orderBy('score', 'desc').limit(1).get();
                currentScore = !snapshot.empty ? snapshot.docs[0].data().score : null;
            }
            
            if (currentScore !== comparisonScores[compareType]) {
                console.log(`Score changed for ${compareType}: ${comparisonScores[compareType]} -> ${currentScore}`);
                await fetchComparisonSplits(compareType, true);
            }
        } catch (error) {
            console.error("Error checking comparison score:", error);
        }
    }
}

// ============================================================================
// User Management
// ============================================================================

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
        const batch = db.batch();
        
        // Update user document
        const userRef = db.collection('users').doc(userId);
        batch.update(userRef, {
            displayName: newName,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        // Update all-time high score if it exists
        const allTimeRef = db.collection('highscores').doc(userId);
        const allTimeDoc = await allTimeRef.get();
        if (allTimeDoc.exists) {
            batch.update(allTimeRef, { displayName: newName });
        }

        // Update daily high score if it exists (for today)
        const today = getTodayDateString();
        const dailyRef = db.collection('dailyhighscores').doc(today).collection('scores').doc(userId);
        const dailyDoc = await dailyRef.get();
        if (dailyDoc.exists) {
            batch.update(dailyRef, { displayName: newName });
        }

        await batch.commit();
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
            await fetchTopScores();
            loop();
        }
    }
}

// ============================================================================
// Score Management
// ============================================================================

async function saveHighScore(score, seed, moves) {
    if (!currentUser) {
        console.error("Cannot save score: user not signed in");
        return;
    }

    try {
        // Refresh display name from database if it's null or looks like a default name
        // This handles cases where the connection was lost or the name wasn't loaded properly
        if (!currentUserDisplayName || currentUserDisplayName.startsWith("Player ")) {
            try {
                const freshDisplayName = await getOrCreateUserDocument(currentUser.uid);
                // Only update if we got a non-default name
                if (freshDisplayName && !freshDisplayName.startsWith("Player ")) {
                    currentUserDisplayName = freshDisplayName;
                    console.log("Refreshed display name:", currentUserDisplayName);
                }
            } catch (refreshError) {
                console.warn("Could not refresh display name:", refreshError);
            }
        }

        const timestamp = firebase.firestore.FieldValue.serverTimestamp();
        const scoreData = {
            userId: currentUser.uid,
            score: score,
            seed: seed,
            moves: moves,
            timestamp: timestamp,
        };

        // Save to scores collection (full history)
        await db.collection('scores').add(scoreData);
        console.log("Score saved successfully:", score);

        // Update all-time high score
        const allTimeRef = db.collection('highscores').doc(currentUser.uid);
        const allTimeDoc = await allTimeRef.get();
        
        if (!allTimeDoc.exists || score > allTimeDoc.data().score) {
            await allTimeRef.set({
                userId: currentUser.uid,
                displayName: currentUserDisplayName,
                score: score,
                seed: seed,
                moves: moves,
                timestamp: timestamp,
            });
            console.log("New all-time high score saved!");
        }

        // Update daily high score
        const today = getTodayDateString();
        const dailyRef = db.collection('dailyhighscores').doc(today).collection('scores').doc(currentUser.uid);
        const dailyDoc = await dailyRef.get();
        
        if (!dailyDoc.exists || score > dailyDoc.data().score) {
            await dailyRef.set({
                userId: currentUser.uid,
                displayName: currentUserDisplayName,
                score: score,
                seed: seed,
                moves: moves,
                timestamp: timestamp,
            });
            console.log("New daily high score saved!");
        }

        // Fetch and display the leaderboard after saving
        // await fetchTopScores();
        // showLeaderboard = true;
        // loop();

    } catch (error) {
        console.error("Error saving score:", error);
    }
}

// ============================================================================
// Leaderboard Caching & Daily WR Splits
// ============================================================================

const LEADERBOARD_CACHE_KEY = "leaderboardCache";

// Persist the in-memory leaderboard so a return to the page shows records
// immediately (the leaderboard is re-fetched in the background to refresh them).
function cacheLeaderboardData() {
    storeItem(LEADERBOARD_CACHE_KEY, {
        daily: { date: getTodayDateString(), scores: topScoresDaily },
        yesterday: { date: getYesterdayDateString(), scores: topScoresYesterday },
        allTime: topScoresAllTime
    });
}

// Restore cached leaderboard records (day-stamped, so stale daily data is
// discarded across a day boundary).
function loadCachedLeaderboardData() {
    let cached;
    try {
        cached = getItem(LEADERBOARD_CACHE_KEY);
    } catch (e) {
        return;
    }
    if (!cached) return;
    const today = getTodayDateString();
    const yesterday = getYesterdayDateString();
    if (cached.daily && cached.daily.date === today && Array.isArray(cached.daily.scores)) {
        topScoresDaily = cached.daily.scores;
    }
    if (cached.yesterday && cached.yesterday.date === yesterday && Array.isArray(cached.yesterday.scores)) {
        topScoresYesterday = cached.yesterday.scores;
    }
    if (Array.isArray(cached.allTime)) {
        topScoresAllTime = cached.allTime;
    }
}

// When today's leaderboard is fetched and a new Daily WR has appeared, keep the
// Daily WR comparison splits in sync — only while the player is comparing against
// the Daily WR, so other comparisons are left untouched.
function refreshDailyWrSplits() {
    const top = topScoresDaily[0];
    if (!top || typeof top.score !== 'number') return;
    if (top.score <= (comparisonScores.dailywr ?? -Infinity)) return;
    if (typeof settings === 'undefined' || settings.compareSplits !== 'dailywr') return;
    if (top.seed == null || !top.moves) return;
    comparisonScores.dailywr = top.score;
    comparisonSplits = replayGameForSplits(top.seed, top.moves);
    console.log('Daily WR splits updated (score ' + top.score + ').');
}

async function fetchTopScores(fetchAllTime = showAllTime) {
    isLoadingScores = true;
    try {
        let snapshot;

        if (fetchAllTime) {
            // Fetch all-time high scores (fetch 16 to account for deduplication)
            snapshot = await db.collection('highscores')
                .orderBy('score', 'desc')
                .limit(16)
                .get();
        } else {
            // Fetch today's high scores (fetch 16 to account for deduplication)
            const today = getTodayDateString();
            snapshot = await db.collection('dailyhighscores').doc(today).collection('scores')
                .orderBy('score', 'desc')
                .limit(16)
                .get();
        }

        // Extract scores with display names already included
        let scores = snapshot.docs.map(doc => doc.data());

        // Deduplicate by display name, keeping highest score for each name
        const nameBestScores = new Map();
        scores.forEach(score => {
            const name = score.displayName || `Player ${score.userId.substring(0, 6)}`;
            if (!nameBestScores.has(name) || score.score > nameBestScores.get(name).score) {
                nameBestScores.set(name, { ...score, displayName: name });
            }
        });

        // Convert to array, sort by score descending, and take top 10
        scores = Array.from(nameBestScores.values());
        scores.sort((a, b) => b.score - a.score);
        scores = scores.slice(0, 10);

        // Cache the results
        if (fetchAllTime) {
            topScoresAllTime = scores;
        } else {
            topScoresDaily = scores;
            refreshDailyWrSplits();
        }
        cacheLeaderboardData();

        console.log(`Top scores fetched (${fetchAllTime ? 'all-time' : 'daily'}):`, scores);
        isLoadingScores = false;
        redraw();
    } catch (error) {
        console.error("Error fetching top scores:", error);
        isLoadingScores = false;
    }
}

async function fetchYesterdayScores() {
    isLoadingScores = true;
    try {
        const yesterday = getYesterdayDateString();
        const snapshot = await db.collection('dailyhighscores').doc(yesterday).collection('scores')
            .orderBy('score', 'desc')
            .limit(16)
            .get();

        // Extract scores with display names already included
        let scores = snapshot.docs.map(doc => doc.data());

        // Deduplicate by display name, keeping highest score for each name
        const nameBestScores = new Map();
        scores.forEach(score => {
            const name = score.displayName || `Player ${score.userId.substring(0, 6)}`;
            if (!nameBestScores.has(name) || score.score > nameBestScores.get(name).score) {
                nameBestScores.set(name, { ...score, displayName: name });
            }
        });

        // Convert to array, sort by score descending, and take top 10
        scores = Array.from(nameBestScores.values());
        scores.sort((a, b) => b.score - a.score);
        scores = scores.slice(0, 10);

        topScoresYesterday = scores;
        cacheLeaderboardData();

        console.log("Yesterday's scores fetched:", scores);
        isLoadingScores = false;
        redraw();
    } catch (error) {
        console.error("Error fetching yesterday's scores:", error);
        isLoadingScores = false;
    }
}

function validateScore(seed, moves, score) {
    let g = new NumberGrid(5, 5, seed, moves);
    return (g.score === score);
}

// ============================================================================
// Global Statistics
// ============================================================================

async function incrementGlobalStats() {
    if (!currentUser || !db) return;

    try {
        const today = getTodayDateString();
        const batch = db.batch();

        // Increment daily stats
        const dailyStatsRef = db.collection('dailystats').doc(today);
        batch.set(dailyStatsRef, {
            gamesPlayed: firebase.firestore.FieldValue.increment(1),
            activeUserIds: firebase.firestore.FieldValue.arrayUnion(currentUser.uid),
            date: today
        }, { merge: true });

        // Increment all-time stats
        const allTimeStatsRef = db.collection('globalstats').doc('totals');
        batch.set(allTimeStatsRef, {
            totalGamesPlayed: firebase.firestore.FieldValue.increment(1)
        }, { merge: true });

        await batch.commit();
        console.log("Global stats incremented");
    } catch (error) {
        console.error("Error incrementing global stats:", error);
    }
}

async function fetchGlobalStats() {
    if (!db) return;

    globalStats.isLoading = true;
    try {
        const today = getTodayDateString();

        // Fetch daily stats
        const dailyStatsDoc = await db.collection('dailystats').doc(today).get();
        if (dailyStatsDoc.exists) {
            const data = dailyStatsDoc.data();
            globalStats.gamesToday = data.gamesPlayed || 0;
            globalStats.activeUsersToday = data.activeUserIds ? data.activeUserIds.length : 0;
        } else {
            globalStats.gamesToday = 0;
            globalStats.activeUsersToday = 0;
        }

        // Fetch all-time stats
        const allTimeStatsDoc = await db.collection('globalstats').doc('totals').get();
        if (allTimeStatsDoc.exists) {
            globalStats.allTimeGames = allTimeStatsDoc.data().totalGamesPlayed || 0;
        } else {
            globalStats.allTimeGames = 0;
        }

        globalStats.isLoading = false;
        console.log("Global stats fetched:", globalStats);
    } catch (error) {
        console.error("Error fetching global stats:", error);
        globalStats.isLoading = false;
    }
}

// ============================================================================
// Firebase Auth Setup
// ============================================================================

function initializeAuth() {
    auth.onAuthStateChanged(async user => {
        if (user) {
            // User is signed in.
            currentUser = user;
            console.log("User signed in anonymously:", currentUser.uid);

            // Load or create user's display name
            currentUserDisplayName = await getOrCreateUserDocument(user.uid);
            console.log("Display name:", currentUserDisplayName);
            
            // Initialize statistics from database if this is first time
            if (typeof initializeStatisticsFromDatabase === 'function') {
                initializeStatisticsFromDatabase();
            }
            
            // Fetch comparison splits based on current setting
            if (typeof settings !== 'undefined' && settings.compareSplits && settings.compareSplits !== "nothing") {
                fetchComparisonSplits(settings.compareSplits);
            }
            
            // Fetch all comparison scores for settings display
            fetchAllComparisonScores();
        } else {
            // User is signed out.
            currentUser = null;
            currentUserDisplayName = null;
            auth.signInAnonymously().catch(error => {
                console.log("Anonymous sign-in failed: " + error);
            });
        }
    });
}
