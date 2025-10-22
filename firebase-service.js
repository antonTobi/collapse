// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const analytics = firebase.analytics();

console.log("Firebase Analytics initialized:", analytics);
console.log("Measurement ID:", firebaseConfig.measurementId);

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
        await db.collection('scores').add({
            userId: currentUser.uid,
            score: score,
            seed: seed,
            moves: moves,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        });
        console.log("Score saved successfully:", score);

        // Fetch and display the leaderboard after saving
        await fetchTopScores();
        showLeaderboard = true;
        loop(); // Redraw to show leaderboard
    } catch (error) {
        console.error("Error saving score:", error);
    }
}

async function fetchTopScores(fetchAllTime = showAllTime) {
    isLoadingScores = true;
    try {
        let snapshot;

        if (fetchAllTime) {
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
        let scores = Array.from(nameBestScores.values());
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
