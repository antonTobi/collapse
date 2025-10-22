// ============================================================================
// p5.js Setup
// ============================================================================

function setup() {
    createCanvas(w * S, h * S + S).mousePressed(onClick);
    textAlign(CENTER, CENTER);
    strokeWeight(2);
    
    // Initialize Firebase authentication
    initializeAuth();

    // Load daily splits data
    loadDailySplits();
    
    // Fetch both daily and all-time scores on page load
    fetchTopScores(false); // Daily scores
    fetchTopScores(true);  // All-time scores

    // Restore saved game or start new game
    let autoSaveSeed = getItem("autoSaveSeed");
    if (autoSaveSeed !== null) {
        let moves = getItem("autoSaveMoves") || "";
        grid = new NumberGrid(w, h, autoSaveSeed, moves.split(""));
    } else {
        newGame();
    }
}

// Set background color
document.body.style.backgroundColor = bgLight;

// ============================================================================
// p5.js Draw Loop
// ============================================================================

function draw() {
    clear();
    grid.draw();
    
    let over = grid.gameOver && grid.settled;
    
    // Draw score bar background
    noStroke();
    fill(over ? "black" : bgLight);
    rect(1, 1, w * S - 2, S - 1);
    
    // Draw score
    fill(over ? "white" : "black");
    if (grid.displayScore < grid.score) {
        grid.displayScore++;
    }

    noStroke();
    textSize(36);
    text(grid.displayScore, width / 2, 42);
    
    // Draw reset button
    stroke(over ? "white" : "black");
    strokeWeight(2);
    let resetX = width - S / 2;
    let resetY = 42;
    line(resetX - 10, resetY, resetX + 10, resetY);
    line(resetX, resetY - 10, resetX, resetY + 10);
    noStroke();
    fill(over ? "white" : "black");

    // Draw score split difference if available
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
    // Draw leaderboard toggle button
    stroke(over ? "white" : "black");
    strokeWeight(2);
    strokeCap(PROJECT)
    let iconX = S / 2;
    let iconY = 42;
    line(iconX - 10, iconY - 8, iconX + 10, iconY - 8);
    line(iconX - 10, iconY, iconX + 10, iconY);
    line(iconX - 10, iconY + 8, iconX + 10, iconY + 8);
    noStroke();

    // Draw leaderboard if toggled on
    if (showLeaderboard) {
        drawLeaderboard();
    }

    // Stop loop when settled and score display is caught up
    if (grid.settled && grid.displayScore == grid.score) {
        noLoop();
    }
}

// ============================================================================
// UI Rendering Functions
// ============================================================================

function drawLeaderboard() {
    // Semi-transparent background
    fill(0, 0, 0, 220);
    stroke(0);
    rect(15, 95, width - 30, height - 110);
    noStroke();

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

    // Get the appropriate cached scores
    let topScores = showAllTime ? topScoresAllTime : topScoresDaily;

    if (topScores.length === 0 && isLoadingScores) {
        // Show loading message only if no cached scores and currently loading
        textSize(18);
        fill(200);
        text("Fetching scores...", width / 2, height / 2);
    } else if (topScores.length === 0) {
        // Show "no scores" message when loaded but empty
        textSize(18);
        fill(200);
        text(showAllTime ? "No scores yet." : "No scores yet today.", width / 2, height / 2);
    } else {
        // Scores (showing cached scores, even while refreshing)
        textSize(16);
        textAlign(LEFT, CENTER);
        let y = 170;
        for (let i = 0; i < topScores.length; i++) {
            let scoreData = topScores[i];
            let displayText = `${i + 1}. ${scoreData.score}`;

            if (scoreData.displayName) {
                displayText += ` (${scoreData.displayName})`;
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

// ============================================================================
// Event Handlers
// ============================================================================

function onClick() {
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

            // Fetch fresh scores in the background when showing the leaderboard
            if (showLeaderboard) {
                fetchTopScores(showAllTime).then(() => {
                    loop(); // Redraw once scores are loaded
                });
            }

            loop(); // Redraw to show/hide leaderboard immediately (cached scores shown)
        }
    } else {
        if (showLeaderboard) {
            // Check if clicking the edit name button in leaderboard (top right area)
            if (mouseY >= 100 && mouseY <= 160 && mouseX >= width - 80 && mouseX <= width - 20) {
                promptForDisplayName();
            } else if (mouseY >= 100 && mouseY <= 160 && mouseX >= 20 && mouseX <= 80) {
                // Toggle between daily and all-time (top left of leaderboard)
                showAllTime = !showAllTime;
                fetchTopScores(showAllTime).then(() => {
                    loop(); // Redraw once scores are loaded
                });
                loop(); // Redraw immediately (will show cached scores if available)
            } else {
                // Clicking elsewhere on leaderboard closes it
                showLeaderboard = false;
            }
        } else {
            grid.click(mouseX, mouseY);
        }
    }
    redraw();
}