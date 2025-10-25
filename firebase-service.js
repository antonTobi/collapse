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
let showLeaderboard = false;
let showAllTime = false;
let isLoadingScores = false;

// Daily Splits State
let splits = [];
let dailyBestScore = 0;

// ============================================================================
// Date Utilities
// ============================================================================

function getTodayDateString() {
    const today = new Date();
    return `${today.getUTCFullYear()}-${today.getUTCMonth() + 1}-${today.getUTCDate()}`;
}

// ============================================================================
// Daily Splits Management
// ============================================================================

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
        }

        console.log(`Top scores fetched (${fetchAllTime ? 'all-time' : 'daily'}):`, scores);
        isLoadingScores = false;
        redraw();
    } catch (error) {
        console.error("Error fetching top scores:", error);
        isLoadingScores = false;
    }
}

function validateScore(seed, moves, score) {
    let g = new NumberGrid(5, 5, seed, moves);
    return (g.score === score);
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
