// ============================================================================
// p5.js Setup
// ============================================================================

let showMoveCount;
let showMenu = false;
let currentMenuTab = "howtoplay"; // "howtoplay", "leaderboards", "achievements", "stats", "settings"
let currentSubTab = {
    leaderboards: "today", // "alltime", "yesterday", "today"
    achievements: "score", // "score", "time", "shape", "other"
    stats: "personal" // "thisgame", "personal", "global"
};
let menuScrollY = 0;
let menuDragStartY = null;
let menuDragStartScrollY = null;
let cachedShapeMatches = null; // Cache for shape matching results
let resetConfirmPending = false; // State for new game confirmation
let resetConfirmTime = 0; // Timestamp for confirmation timeout
let currentAppVersion = null; // Track current app version
let newVersionAvailable = false; // Flag if new version detected
let canvas; // Canvas reference for event listeners

let debug = false; // Set to true to enable debug features

// Settings (stored in localStorage)
let settings = {
    disableAnimation: false,
    showShapes: false,
    extraStat: "nothing", // "nothing", "moves", "time"
    challengeMode: "none", // "none", "bottomrow", "middlecolumn"
    compareSplits: "nothing" // "nothing", "pb", "dailypb", "wr", "dailywr"
};

// Game over popup state
let gameOverPopupPending = false;
let gameOverSettledTime = null;

// Discord link bounds for click detection
let discordLinkBounds = null;
const DISCORD_URL = "https://discord.gg/4EgJ8rjVag";

// Achievement notification
let achievementNotification = null; // Text to display
let achievementNotificationTime = 0; // Timestamp when notification was set
const ACHIEVEMENT_NOTIFICATION_DURATION = 4000; // 4 seconds

// Split diff display
let splitDiffDisplayTime = 0; // Timestamp when split diff was set
const SPLIT_DIFF_DURATION = 3000; // 3 seconds visible

// Game over leaderboard state
let gameOverLeaderboardReady = false; // True when leaderboard has been refreshed after game over

// Statistics
let statistics = {
    personalBest: 0,
    personalWorst: null, // null means no completed games yet
    bestWithoutBottomRow: null, // Best score without using bottom row
    bestWithoutMiddleColumn: null, // Best score without using middle column
    largestChains: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    gamesPlayed: 0,
    fastestTo1000: null, // in ms
    fastestTo3000: null,
    fastestTo5000: null,
    fastestTo7000: null,
    gamesOver7000: 0,
    gamesOver8000: 0,
    gamesOver9000: 0,
    gamesOver10000: 0
};

// Game History
let gameHistory = []; // Array to store last 7 scores

function setup() {
    canvas = createCanvas(w * S, h * S + S);
    canvas.mousePressed(onClick);

    // Add touch event listeners for mobile support
    canvas.elt.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.elt.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.elt.addEventListener('touchend', handleTouchEnd, { passive: false });

    // Close menu when clicking outside the canvas
    document.addEventListener('click', handleDocumentClick);

    textAlign(CENTER, CENTER);
    textFont('Roboto');
    strokeWeight(2);

    // Initialize Firebase authentication
    initializeAuth();

    // Load daily splits data
    loadDailySplits();

    // Initialize achievement system
    initializeAchievements();

    // Initialize statistics
    initializeStatistics();

    // Initialize game history
    initializeGameHistory();

    // Initialize settings
    initializeSettings();

    // Restore last opened menu tab and subtabs
    let savedMenuTab = getItem("currentMenuTab");
    if (savedMenuTab !== null && ["howtoplay", "leaderboards", "achievements", "stats", "settings"].includes(savedMenuTab)) {
        currentMenuTab = savedMenuTab;
    }
    let savedSubTabs = getItem("currentSubTab");
    if (savedSubTabs !== null) {
        currentSubTab = { ...currentSubTab, ...savedSubTabs };
    }

    // Restore menu open state
    let savedShowMenu = getItem("showMenu");
    if (savedShowMenu !== null) {
        showMenu = savedShowMenu;
    }

    // Restore saved game or start new game
    let autoSaveSeed = getItem("autoSaveSeed");
    if (autoSaveSeed !== null) {
        let moves = getItem("autoSaveMoves") || "";
        grid = new NumberGrid(w, h, autoSaveSeed, moves.split(""), true); // skipAnimation = true
        // Restore move times
        let savedFirstMoveTime = getItem("autoSaveFirstMoveTime");
        if (savedFirstMoveTime !== null) {
            grid.firstMoveTime = savedFirstMoveTime;
        }
        let savedLastMoveTime = getItem("autoSaveLastMoveTime");
        if (savedLastMoveTime !== null) {
            grid.lastMoveTime = savedLastMoveTime;
        }
    } else {
        newGame();
    }

    showMoveCount = getItem("showMoveCount")
    if (showMoveCount === null) {
        showMoveCount = false
    }

    // Start version checking
    initializeVersionCheck();

    // Set background color
    document.body.style.backgroundColor = bgLight;
}

// ============================================================================
// p5.js Draw Loop
// ============================================================================

function draw() {
    background(bgLight);
    grid.draw();

    let over = grid.gameOver && grid.settled;

    // Draw score bar background
    noStroke();
    fill(over ? "black" : bgLight);
    rect(1, 1, w * S - 2, S - 1);

    // Draw score
    fill(over ? "white" : "black");
    if (grid.displayScore < grid.score) {
        if (settings.disableAnimation) {
            grid.displayScore = grid.score;
        } else {
            grid.displayScore++;
        }
    }


    textSize(36)
    text(grid.displayScore, width / 2, 38);

    textSize(15);
    if (over) {
        // Game over state - show "Game Over" text
        fill(255);
        noStroke();
        text("Game Over", width / 2, 66);
    } else {
        // Check if split diff should be displayed (takes priority over extra stat)
        let showingSplitDiff = false;
        let splitDiffAlpha = 255;
        
        if (settings.compareSplits !== "nothing" && grid.scoreSplitDiff !== null) {
            let elapsed = Date.now() - splitDiffDisplayTime;
            if (elapsed < SPLIT_DIFF_DURATION) {
                showingSplitDiff = true;
                
                // Calculate alpha for fadeout in last 0.5 seconds
                let fadeStartTime = SPLIT_DIFF_DURATION - 500;
                if (elapsed > fadeStartTime) {
                    splitDiffAlpha = 255 * (1 - (elapsed - fadeStartTime) / 500);
                }
            }
        }
        
        // Always draw extra stat first (underneath), so it shows through during fadeout
        if (settings.extraStat !== "nothing") {
            let extraStatText = "";
            if (settings.extraStat === "moves") {
                extraStatText = grid.moves.length + " moves";
            } else if (settings.extraStat === "time") {
                extraStatText = formatTime(grid.firstMoveTime !== null ? Date.now() - grid.firstMoveTime : 0);
            }
            
            if (extraStatText) {
                fill(0);
                noStroke();
                text(extraStatText, width / 2, 66);
            }
        }
        
        // Draw split diff on top with background rectangle
        if (showingSplitDiff) {
            let sign;
            let textColor;
            
            if (grid.scoreSplitDiff < 0) {
                sign = "";
                textColor = color(128); // Gray
            } else if (grid.scoreSplitDiff === 0) {
                sign = "=";
                textColor = color(128); // Gray
            } else {
                sign = "+";
                textColor = color(10, 10, 240); // Blue
            }
            
            let splitText =sign + grid.scoreSplitDiff;
            
            // Add "vs" label based on comparison type
            let vsLabel = "";
            if (settings.compareSplits === "pb") vsLabel = " vs PB";
            else if (settings.compareSplits === "dailypb") vsLabel = " vs DPB";
            else if (settings.compareSplits === "wr") vsLabel = " vs WR";
            else if (settings.compareSplits === "dailywr") vsLabel = " vs DWR";
            splitText += vsLabel;
            
            // Draw background rectangle to cover extra stat (only needed if there's an extra stat)
            if (settings.extraStat !== "nothing") {
                noStroke();
                fill(red(color(bgLight)), green(color(bgLight)), blue(color(bgLight)), splitDiffAlpha);
                // Use a fixed width that covers typical extra stat text
                let rectWidth = 180;
                let rectHeight = 24;
                rect(width / 2 - rectWidth / 2, 66 - rectHeight / 2, rectWidth, rectHeight);
            }
            
            // Draw split diff text with alpha
            fill(red(textColor), green(textColor), blue(textColor), splitDiffAlpha);
            noStroke();
            text(splitText, width / 2, 66);
        }
    }

    // Draw achievement notification if active
    if (achievementNotification !== null) {
        let elapsed = Date.now() - achievementNotificationTime;
        if (elapsed < ACHIEVEMENT_NOTIFICATION_DURATION) {
            // Calculate fade out in last 500ms
            let alpha = 255;
            if (elapsed > ACHIEVEMENT_NOTIFICATION_DURATION - 500) {
                alpha = 255 * (1 - (elapsed - (ACHIEVEMENT_NOTIFICATION_DURATION - 500)) / 500);
            }

            // Split text into lines for multiline support
            let lines = achievementNotification.split('\n');
            let lineHeight = 16;
            let notificationY = 66; // Same Y as score split / game over message
            let maxLineWidth = Math.max(...lines.map(line => line.length)) * 8; // Approximate width
            let padding = 8;
            let boxHeight = lines.length * lineHeight + padding;

            // Draw black background
            fill(0, 0, 0, alpha * 0.8);
            noStroke();
            rect(width / 2 - maxLineWidth / 2 - padding, notificationY - boxHeight / 2, maxLineWidth + padding * 2, boxHeight, 4);

            // Draw text lines
            fill(255, 215, 0, alpha); // Gold color with fade
            textSize(14);
            for (let i = 0; i < lines.length; i++) {
                let lineY = notificationY + (i - (lines.length - 1) / 2) * lineHeight;
                text(lines[i], width / 2, lineY);
            }
        } else {
            achievementNotification = null;
        }
    }

    // Draw reset button
    stroke(over ? "white" : "black");
    strokeWeight(2);
    let resetX = width - S / 2;
    let resetY = 42;

    // Check for reset confirmation timeout
    if (resetConfirmPending && millis() - resetConfirmTime > 2000) {
        resetConfirmPending = false;
    }

    if (resetConfirmPending) {
        // Draw checkmark
        line(resetX - 8, resetY, resetX - 2, resetY + 6);
        line(resetX - 2, resetY + 6, resetX + 10, resetY - 6);
    } else {
        // Draw +
        line(resetX - 10, resetY, resetX + 10, resetY);
        line(resetX, resetY - 10, resetX, resetY + 10);
    }
    noStroke();
    fill(over ? "white" : "black");

    // Draw score split difference if available
    // if (grid.scoreSplitDiff !== null) {
    //     let sign;
    //     let textColor;
    //     if (grid.scoreSplitDiff < 0) {
    //         sign = "";
    //         textColor = "red";
    //     } else if (grid.scoreSplitDiff === 0) {
    //         sign = "=";
    //         textColor = "gray";
    //     } else {
    //         sign = "+";
    //         textColor = "blue";
    //     }
    //     fill(textColor);
    //     textSize(16);
    //     text("(" + sign + grid.scoreSplitDiff + ")", width / 2, S - 14);
    // }

    // if (showSplits && (grid.displaySplit !== grid.displayScore)) {
    //     fill(0)
    //     textSize(16)
    //     // text("(" + grid.displaySplit + ")", width / 2, S - 13);
    //     text(grid.displaySplit, width / 2, S - 12);
    // }

    textSize(32);
    // Draw menu toggle button (hamburger icon)
    stroke(over ? "white" : "black");
    strokeWeight(2);
    strokeCap(PROJECT)
    let iconX = S / 2;
    let iconY = 42;
    line(iconX - 10, iconY - 8, iconX + 10, iconY - 8);
    line(iconX - 10, iconY, iconX + 10, iconY);
    line(iconX - 10, iconY + 8, iconX + 10, iconY + 8);
    noStroke();

    // Draw unified menu panel if toggled on
    if (showMenu) {
        drawMenuPanel();
    }

    // Keep loop running if: animation in progress, score animating, notification showing, reset pending, or time clock displayed
    let needsContinuousLoop = !grid.settled || grid.displayScore !== grid.score || achievementNotification !== null || resetConfirmPending;

    // Also keep loop running if split diff overlay is being displayed (for fade animation)
    if (settings.compareSplits !== "nothing" && grid.scoreSplitDiff !== null && Date.now() - splitDiffDisplayTime < SPLIT_DIFF_DURATION) {
        needsContinuousLoop = true;
    }

    // Also keep loop running if time is being displayed (for live clock updates)
    if (!grid.gameOver && settings.extraStat === "time" && grid.firstMoveTime !== null) {
        needsContinuousLoop = true;
    }

    // Keep loop running if stats menu is open showing "This Game" tab (for live time)
    if (showMenu && currentMenuTab === "stats" && currentSubTab.stats === "thisgame" && !grid.gameOver) {
        needsContinuousLoop = true;
    }

    // Handle delayed game over popup
    // Handle game over leaderboard display
    if (gameOverPopupPending) {
        // Wait for animation to settle
        if (grid.settled && gameOverSettledTime === null) {
            gameOverSettledTime = Date.now();
        }
        // Show leaderboard when both settled AND leaderboard data is ready
        if (gameOverSettledTime !== null && gameOverLeaderboardReady) {
            gameOverPopupPending = false;
            gameOverSettledTime = null;
            gameOverLeaderboardReady = false;
            showMenu = true;
            currentMenuTab = "leaderboards";
            currentSubTab.leaderboards = "today";
            storeItem("currentSubTab", currentSubTab);
            menuScrollY = 0;
        }
        needsContinuousLoop = true;
    }

    if (!needsContinuousLoop) {
        noLoop();
    }

    // text(frameCount, 20, 20)
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatTime(ms) {
    let totalSeconds = Math.floor(ms / 1000);
    let hours = Math.floor(totalSeconds / 3600);
    let minutes = Math.floor((totalSeconds % 3600) / 60);
    let seconds = totalSeconds % 60;

    if (hours > 0) {
        return hours + "h " + String(minutes).padStart(2, '0') + "m";
    } else {
        return String(minutes).padStart(2, '0') + ":" + String(seconds).padStart(2, '0');
    }
}

// ============================================================================
// UI Rendering Functions
// ============================================================================

function drawThisGameStats(panelX, contentStartY, panelWidth, contentHeight) {
    let lineHeight = 30;
    
    // Calculate total content height
    let totalHeight = 20 + lineHeight * 2; // Moves and Time
    if (grid.sixSplits.length > 0) {
        totalHeight += 10 + lineHeight + 30 + 20; // Score splits section
    }
    totalHeight += 20 + 25; // Heatmap header
    let heatmapCellSize = 50; // Size to fit 3-digit numbers
    totalHeight += heatmapCellSize * 5 + 20; // 5x5 heatmap
    
    // Clamp scroll position
    let maxScroll = Math.max(0, totalHeight - contentHeight);
    menuScrollY = Math.max(0, Math.min(menuScrollY, maxScroll));
    
    // Clip to content area
    push();
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(panelX, contentStartY, panelWidth, contentHeight);
    drawingContext.clip();
    
    let contentY = contentStartY + 20 - menuScrollY;

    // Number of moves
    textSize(16);
    textAlign(LEFT, CENTER);
    fill(255);
    text("Moves:", panelX + 20, contentY);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    text(grid.moves.length, panelX + panelWidth - 20, contentY);
    contentY += lineHeight;

    // Time taken
    textAlign(LEFT, CENTER);
    fill(255);
    text("Time:", panelX + 20, contentY);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    if (grid.firstMoveTime !== null) {
        let endTime = grid.gameOver ? (grid.lastMoveTime || grid.firstMoveTime) : Date.now();
        let totalMs = endTime - grid.firstMoveTime;
        text(formatTime(totalMs), panelX + panelWidth - 20, contentY);
    } else {
        text("-", panelX + panelWidth - 20, contentY);
    }
    contentY += lineHeight;

    // Score splits section - only show if there are 6-splits
    if (grid.sixSplits.length > 0) {
        contentY += 10;
        textAlign(LEFT, CENTER);
        fill(255);
        textSize(18);
        text("Score splits:", panelX + 20, contentY);
        contentY += lineHeight;
        // Calculate individual split values
        let splitValues = [];
        let sixSplits = grid.sixSplits;
        for (let i = 0; i < sixSplits.length; i++) {
            if (i === 0) {
                splitValues.push(sixSplits[0]);
            } else {
                splitValues.push(sixSplits[i] - sixSplits[i - 1]);
            }
        }
        // Add the final segment (remaining score after last split)
        let lastSplit = sixSplits[sixSplits.length - 1] || 0;
        if (grid.score > lastSplit) {
            splitValues.push(grid.score - lastSplit);
        }

        // Draw the score splits bar
        let barX = panelX + 20;
        let barWidth = panelWidth - 40;
        let barHeight = 30;
        let barY = contentY;

        // Colors for split segments (alternate between box colors 4 and 5)
        let splitColors = [boxColors[1], boxColors[4]];

        // Draw each segment
        let currentX = barX;
        let totalScore = grid.score > 0 ? grid.score : 1;
        for (let i = 0; i < splitValues.length; i++) {
            let segmentWidth = (splitValues[i] / totalScore) * barWidth;
            fill(splitColors[i % splitColors.length]);
            noStroke();
            rect(currentX, barY, segmentWidth, barHeight);

            // Draw split value on segment if it fits
            let splitLabel = splitValues[i].toString();
            textSize(13);
            let labelWidth = textWidth(splitLabel);
            if (labelWidth + 6 < segmentWidth) {
                fill(255);
                textAlign(CENTER, CENTER);
                text(splitLabel, currentX + segmentWidth / 2, barY + barHeight / 2);
            }

            currentX += segmentWidth;
        }
        contentY += 30 + 20; // bar height + spacing
    }

    // Position heatmap section
    contentY += 20;
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);
    text("Move heatmap:", panelX + 20, contentY);
    contentY += 25;
    
    // Draw 5x5 heatmap centered
    let cellSize = 50;
    let heatmapWidth = cellSize * 5;
    let heatmapX = panelX + (panelWidth - heatmapWidth) / 2;
    let heatmapY = contentY;
    
    // Find max value for color scaling
    let maxCount = 1;
    if (grid.positionHeatmap) {
        for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) {
                if (grid.positionHeatmap[i][j] > maxCount) {
                    maxCount = grid.positionHeatmap[i][j];
                }
            }
        }
    }
    
    textSize(14);
    for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
            let count = grid.positionHeatmap ? grid.positionHeatmap[i][j] : 0;
            let cellX = heatmapX + i * cellSize;
            // j=0 is bottom row in game, so flip for display (j=0 at bottom)
            let cellY = heatmapY + (4 - j) * cellSize;
            
            // Color based on count (darker = fewer, brighter = more)
            let intensity = count > 0 ? map(count, 0, maxCount, 40, 200) : 20;
            let hue = count > 0 ? map(count, 0, maxCount, 200, 0) : 0; // Blue to red
            
            // Use a gradient from dark blue to bright red/orange
            if (count === 0) {
                fill(30, 30, 40);
            } else {
                // Interpolate from blue (low) to red (high)
                let r = map(count, 0, maxCount, 50, 255);
                let g = map(count, 0, maxCount, 50, 100);
                let b = map(count, 0, maxCount, 150, 50);
                fill(r, g, b);
            }
            
            stroke(60);
            strokeWeight(1);
            rect(cellX, cellY, cellSize, cellSize);
            
            // Draw count number
            noStroke();
            fill(count > 0 ? 255 : 100);
            textAlign(CENTER, CENTER);
            text(count, cellX + cellSize / 2, cellY + cellSize / 2);
        }
    }
    
    // Restore clipping
    drawingContext.restore();
    pop();
    
    // Draw scrollbar if content overflows
    if (totalHeight > contentHeight) {
        let scrollbarX = panelX + panelWidth - 8;
        let scrollbarHeight = contentHeight * (contentHeight / totalHeight);
        let scrollbarY = contentStartY + (menuScrollY / maxScroll) * (contentHeight - scrollbarHeight);
        
        fill(100, 150);
        noStroke();
        rect(scrollbarX, scrollbarY, 4, scrollbarHeight, 2);
    }

    textAlign(CENTER, CENTER);
}

function drawMenuPanel() {
    // Semi-transparent background
    fill(0, 0, 0, 220);
    stroke(0);
    let panelX = 15;
    let panelY = 95;
    let panelWidth = width - 30;
    let panelHeight = height - 110;
    rect(panelX, panelY, panelWidth, panelHeight);
    noStroke();

    // Draw main tabs
    let tabY = 110;
    let tabHeight = 35;
    let tabs = [
        { id: "howtoplay", icon: "❓", title: "How to Play" },
        { id: "leaderboards", icon: "🏆", title: "Leaderboards" },
        { id: "achievements", icon: "⭐", title: "Achievements" },
        { id: "stats", icon: "📊", title: "Stats" },
        { id: "settings", icon: "⚙️", title: "Settings" }
    ];
    let tabWidth = panelWidth / tabs.length;

    for (let i = 0; i < tabs.length; i++) {
        let tab = tabs[i];
        let tabX = panelX + i * tabWidth;

        // Tab background
        if (currentMenuTab === tab.id) {
            fill(60);
        } else {
            fill(30);
        }
        rect(tabX, tabY, tabWidth, tabHeight);

        // Tab icon
        if (currentMenuTab === tab.id) {
            fill(255, 215, 0);
        } else {
            fill(180);
        }
        textSize(20);
        textAlign(CENTER, CENTER);
        text(tab.icon, tabX + tabWidth / 2, tabY + tabHeight / 2);
    }

    // Draw title and subtabs for current tab
    let currentTab = tabs.find(t => t.id === currentMenuTab);
    let subTabY = tabY + tabHeight + 5;
    let subTabHeight = 28;
    let contentStartY = subTabY + 35;

    // Draw subtabs if applicable
    let subtabs = null;
    if (currentMenuTab === "leaderboards") {
        subtabs = [
            { id: "alltime", label: "All-Time" },
            { id: "yesterday", label: "Yesterday" },
            { id: "today", label: "Today" }
        ];
    } else if (currentMenuTab === "achievements") {
        subtabs = [
            { id: "score", label: "Score" },
            { id: "time", label: "Time" },
            { id: "shape", label: "Shape" },
            { id: "other", label: "Other" }
        ];
    } else if (currentMenuTab === "stats") {
        subtabs = [
            { id: "thisgame", label: "This Game" },
            { id: "personal", label: "Personal" },
            { id: "global", label: "Global" }
        ];
    }

    if (subtabs) {
        let subTabWidth = (panelWidth - 20) / subtabs.length;
        for (let i = 0; i < subtabs.length; i++) {
            let subtab = subtabs[i];
            let subTabX = panelX + 10 + i * subTabWidth;
            let isActive = currentSubTab[currentMenuTab] === subtab.id;

            // Subtab background
            fill(isActive ? 80 : 40);
            rect(subTabX, subTabY, subTabWidth, subTabHeight, 4);

            // Subtab text
            fill(isActive ? 255 : 150);
            textSize(14);
            textAlign(CENTER, CENTER);
            text(subtab.label, subTabX + subTabWidth / 2, subTabY + subTabHeight / 2);
        }
        contentStartY = subTabY + subTabHeight + 10;
    } else {
        // Draw title for tabs without subtabs
        fill(255);
        textSize(18);
        textAlign(CENTER, CENTER);
        text(currentTab.title, width / 2, subTabY + 12);
        contentStartY = subTabY + 30;
    }

    // Content area
    let contentHeight = panelHeight - (contentStartY - panelY);

    if (currentMenuTab === "howtoplay") {
        drawHowToPlayContent(panelX, contentStartY, panelWidth, contentHeight);
    } else if (currentMenuTab === "leaderboards") {
        drawLeaderboardContent(panelX, contentStartY, panelWidth, contentHeight);
    } else if (currentMenuTab === "achievements") {
        drawAchievementContent(panelX, contentStartY, panelWidth, contentHeight);
    } else if (currentMenuTab === "stats") {
        if (currentSubTab.stats === "thisgame") {
            drawThisGameStats(panelX, contentStartY, panelWidth, contentHeight);
        } else if (currentSubTab.stats === "personal") {
            drawPersonalStatsContent(panelX, contentStartY, panelWidth, contentHeight);
        } else {
            drawGlobalStatsContent(panelX, contentStartY, panelWidth, contentHeight);
        }
    } else if (currentMenuTab === "settings") {
        drawSettingsContent(panelX, contentStartY, panelWidth, contentHeight);
    }
}

function drawHowToPlayContent(panelX, contentStartY, panelWidth, contentHeight) {
    let lines = [
        "• Click a group of matching tiles to collapse",
        "  them into a single tile with a higher value.",
        `• Collapsing a group of 5's creates a ${settings.showShapes ? "shape" : "blank"}`,
        "  tile, which cannot be further collapsed.",
        "• The game ends when no more moves are",
        "  possible!",
    ];

    // Calculate total height (including Discord link)
    let totalHeight = lines.length * 28 + 20 + 56; // Extra space for Discord link

    // Clamp scroll position
    let maxScroll = Math.max(0, totalHeight - contentHeight);
    menuScrollY = Math.max(0, Math.min(menuScrollY, maxScroll));

    // Clip to content area
    push();
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(panelX, contentStartY, panelWidth, contentHeight);
    drawingContext.clip();

    textAlign(LEFT, TOP);
    fill(255);
    textSize(width < 400 ? 15 : 16);

    let y = contentStartY + 10 - menuScrollY;
    fill(255);
    for (let line of lines) {
        text(line, panelX + 20, y);
        y += 28;
    }

    // Draw Discord link (blue and underlined)
    y += 28; // Extra spacing before Discord link
    let discordText = "Join our Discord server!";
    fill(100, 150, 255); // Blue color
    textAlign(CENTER, TOP);
    let linkX = width / 2;
    text(discordText, linkX, y);

    // Draw underline
    let linkWidth = textWidth(discordText);
    let linkHeight = 20;
    stroke(100, 150, 255);
    strokeWeight(1);
    line(linkX - linkWidth / 2, y + linkHeight, linkX + linkWidth / 2, y + linkHeight);
    noStroke();

    // Store link bounds for click detection (only if visible in content area)
    let linkY = y;
    if (linkY >= contentStartY - linkHeight && linkY <= contentStartY + contentHeight) {
        discordLinkBounds = {
            x: linkX - linkWidth / 2,
            y: Math.max(contentStartY, linkY),
            width: linkWidth,
            height: linkHeight + 5
        };
    } else {
        discordLinkBounds = null;
    }

    drawingContext.restore();
    pop();

    // Draw scroll indicator if needed
    if (maxScroll > 0) {
        fill(100);
        let scrollBarHeight = (contentHeight / totalHeight) * contentHeight;
        let scrollBarY = contentStartY + (menuScrollY / maxScroll) * (contentHeight - scrollBarHeight);
        rect(panelX + panelWidth - 8, scrollBarY, 4, scrollBarHeight, 2);
    }

    textAlign(CENTER, CENTER);
}

function drawLeaderboardContent(panelX, contentStartY, panelWidth, contentHeight) {
    let subTab = currentSubTab.leaderboards;
    let topScores;
    let emptyMessage;

    if (subTab === "alltime") {
        topScores = topScoresAllTime;
        emptyMessage = "No scores yet.";
    } else if (subTab === "yesterday") {
        topScores = topScoresYesterday || [];
        emptyMessage = "No scores from yesterday.";
    } else {
        topScores = topScoresDaily;
        emptyMessage = "No scores yet today.";
    }

    if (topScores.length === 0 && isLoadingScores) {
        textSize(18);
        fill(200);
        textAlign(CENTER, CENTER);
        text("Fetching scores...", width / 2, contentStartY + contentHeight / 2);
    } else if (topScores.length === 0) {
        textSize(18);
        fill(200);
        textAlign(CENTER, CENTER);
        text(emptyMessage, width / 2, contentStartY + contentHeight / 2);
    } else {
        textSize(16);
        textAlign(LEFT, CENTER);
        let y = contentStartY + 10;
        for (let i = 0; i < topScores.length; i++) {
            let scoreData = topScores[i];
            let displayText = `${i + 1}. ${scoreData.score}`;

            if (scoreData.displayName) {
                displayText += ` (${scoreData.displayName})`;
            }

            if (scoreData.userId === currentUser?.uid) {
                fill(255, 255, 0);
            } else {
                fill(255);
            }

            text(displayText, panelX + 20, y);
            y += 25;
        }
    }

    // Edit name button
    fill(180);
    textSize(16);
    textAlign(RIGHT, CENTER);
    text("✏️ Edit name", width - 35, contentStartY + contentHeight - 20);

    textAlign(CENTER, CENTER);
}

function drawPersonalStatsContent(panelX, contentStartY, panelWidth, contentHeight) {
    // Calculate total content height
    let totalHeight = 30 + 30 + 30 + 15 + 30 + 50 + 15 + 30 + 30 + 15 + 30 + 30 + 20 + 150; // Stats + chains + fastest + high scores + history graph

    // Clamp scroll position
    let maxScroll = Math.max(0, totalHeight - contentHeight);
    menuScrollY = Math.max(0, Math.min(menuScrollY, maxScroll));

    // Clip to content area
    push();
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(panelX, contentStartY, panelWidth, contentHeight);
    drawingContext.clip();

    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);

    let y = contentStartY + 20 - menuScrollY;
    let lineHeight = 28;

    // Personal Highest Score
    text("Highest score:", panelX + 20, y);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    text(statistics.personalBest, panelX + panelWidth - 20, y);
    y += lineHeight;

    // Personal Lowest Score
    textAlign(LEFT, CENTER);
    fill(255);
    text("Lowest score:", panelX + 20, y);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    text(statistics.personalWorst != null ? statistics.personalWorst : "-", panelX + panelWidth - 20, y);
    y += lineHeight;

    // Best score without bottom row
    textAlign(LEFT, CENTER);
    fill(255);
    text("Best w/o bottom row:", panelX + 20, y);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    text(statistics.bestWithoutBottomRow != null ? statistics.bestWithoutBottomRow : "-", panelX + panelWidth - 20, y);
    y += lineHeight;

    // Best score without middle column
    textAlign(LEFT, CENTER);
    fill(255);
    text("Best w/o middle col:", panelX + 20, y);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    text(statistics.bestWithoutMiddleColumn != null ? statistics.bestWithoutMiddleColumn : "-", panelX + panelWidth - 20, y);
    y += lineHeight;

    // Total Games Played
    textAlign(LEFT, CENTER);
    fill(255);
    text("Games played:", panelX + 20, y);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    text(statistics.gamesPlayed, panelX + panelWidth - 20, y);
    y += lineHeight + 10;

    // Largest Chains header
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);
    text("Largest chains:", panelX + 20, y);
    y += 25;

    // Display all tile types on one row - spread out to use full width
    // Account for tile + "×XX" text width when centering
    textSize(14);
    let tileSize = 26;
    let itemFullWidth = tileSize + 32; // tile + "×XX" text approximate width
    let availableWidth = panelWidth - 40; // 20px padding on each side
    let tileSpacing = availableWidth / 5;
    let startX = panelX + 12 + tileSpacing / 2 - itemFullWidth / 2 + tileSize / 2;

    for (let tileType = 1; tileType <= 5; tileType++) {
        let tileX = startX + (tileType - 1) * tileSpacing;

        fill(boxColors[tileType]);
        noStroke();
        rect(tileX, y - 13, tileSize, tileSize);

        fill(255, 230);
        textSize(18);
        textAlign(CENTER, CENTER);
        text(tileType, tileX + tileSize / 2, y);

        textAlign(LEFT, CENTER);
        fill(255);
        textSize(14);
        text("×" + statistics.largestChains[tileType], tileX + tileSize + 4, y);
    }

    y += 35;

    // Fastest times - single row (4x1), format: [1k] MM:SS
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);
    text("Fastest times:", panelX + 20, y);
    y += 27;

    let timeTileSize = 26;
    let timeItemWidth = (panelWidth - 40) / 4;
    let fastestData = [
        { score: "1k", time: statistics.fastestTo1000 },
        { score: "3k", time: statistics.fastestTo3000 },
        { score: "5k", time: statistics.fastestTo5000 },
        { score: "7k", time: statistics.fastestTo7000 }
    ];

    let timeColors = [boxColors[6], boxColors[6], boxColors[6], boxColors[6]]

    for (let i = 0; i < 4; i++) {
        let itemCenterX = panelX + 20 + i * timeItemWidth + timeItemWidth / 2;
        let tileX = itemCenterX - timeTileSize / 2 - 18;

        // Draw colored tile
        fill(timeColors[i]);
        noStroke();
        rect(tileX, y - timeTileSize / 2, timeTileSize, timeTileSize);

        // Draw score label on tile
        fill(255, 230);
        textSize(14);
        textAlign(CENTER, CENTER);
        text(fastestData[i].score, tileX + timeTileSize / 2, y);

        // Draw time
        textAlign(LEFT, CENTER);
        fill(255, 215, 0);
        textSize(13);
        let timeText = fastestData[i].time !== null ? formatTime(fastestData[i].time) : "-";
        text(timeText, tileX + timeTileSize + 6, y);
    }
    y += 32;

    // High score counts - single row (4x1), format: [tile] ×X
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);
    text("High-scoring games:", panelX + 20, y);
    y += 27;

    let scoreTileSize = 26;
    let scoreItemWidth = (panelWidth - 40) / 4;
    let scoreData = [
        { score: "7k", count: statistics.gamesOver7000 || 0 },
        { score: "8k", count: statistics.gamesOver8000 || 0 },
        { score: "9k", count: statistics.gamesOver9000 || 0 },
        { score: "10k", count: statistics.gamesOver10000 || 0 }
    ];

    let scoreColors = [boxColors[6], boxColors[6], boxColors[6], boxColors[6]]

    for (let i = 0; i < 4; i++) {
        let itemCenterX = panelX + 20 + i * scoreItemWidth + scoreItemWidth / 2;
        let tileX = itemCenterX - scoreTileSize / 2 - 15;

        // Draw colored tile
        fill(scoreColors[i]);
        noStroke();
        rect(tileX, y - scoreTileSize / 2, scoreTileSize, scoreTileSize);

        // Draw score label on tile
        fill(255, 230);
        textSize(13);
        textAlign(CENTER, CENTER);
        text(scoreData[i].score, tileX + scoreTileSize / 2, y);

        // Draw count
        textAlign(LEFT, CENTER);
        fill(255);
        textSize(14);
        text("×" + scoreData[i].count, tileX + scoreTileSize + 5, y);
    }
    y += 35;

    // Game History Graph - only show if at least 3 scores
    if (gameHistory.length >= 3) {
        textAlign(LEFT, CENTER);
        fill(255);
        textSize(16);
        text("Recent scores:", panelX + 20, y);
        y += 25;

        let labelSpace = 15; // Space for score labels above bars
        let graphHeight = 105;
        let graphWidth = panelWidth - 40;
        let graphX = panelX + 20;
        let graphY = y + labelSpace;

        let maxScore = Math.max(...gameHistory);
        let maxYValue = Math.ceil(maxScore / 1000) * 1000;
        if (maxYValue === 0) maxYValue = 1000;

        // Draw grid lines
        stroke(60);
        strokeWeight(1);
        for (let i = 0; i <= 4; i++) {
            let lineY = graphY + graphHeight - (i / 4) * graphHeight;
            line(graphX, lineY, graphX + graphWidth, lineY);
        }

        // Draw bars
        let barWidth = graphWidth / gameHistory.length;
        let barPadding = barWidth * 0.2;

        noStroke();
        for (let i = 0; i < gameHistory.length; i++) {
            let score = gameHistory[gameHistory.length - 1 - i];
            let barHeight = (score / maxYValue) * graphHeight;
            let barX = graphX + i * barWidth + barPadding / 2;
            let barY = graphY + graphHeight - barHeight;

            // Draw bars in white
            fill(255);
            rect(barX, barY, barWidth - barPadding, barHeight);

            // Draw score label above bar (if it fits in view)
            if (barY - 10 >= graphY - 15) {
                fill(255);
                textSize(10);
                textAlign(CENTER, CENTER);
                text(score, barX + (barWidth - barPadding) / 2, barY - 10);
            }
        }

        stroke(150);
        strokeWeight(2);
        line(graphX, graphY + graphHeight, graphX + graphWidth, graphY + graphHeight);
        noStroke();
    }

    drawingContext.restore();
    pop();

    // Draw scroll indicator if needed
    if (maxScroll > 0) {
        fill(100);
        let scrollBarHeight = (contentHeight / totalHeight) * contentHeight;
        let scrollBarY = contentStartY + (menuScrollY / maxScroll) * (contentHeight - scrollBarHeight);
        rect(panelX + panelWidth - 8, scrollBarY, 4, scrollBarHeight, 2);
    }

    textAlign(CENTER, CENTER);
}

function drawGlobalStatsContent(panelX, contentStartY, panelWidth, contentHeight) {
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);

    let y = contentStartY + 20;
    let lineHeight = 30;

    // Games Played Today (Global)
    text("Games today:", panelX + 20, y);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    text(globalStats.isLoading ? "..." : globalStats.gamesToday, panelX + panelWidth - 20, y);
    y += lineHeight;

    // Active Users Today
    textAlign(LEFT, CENTER);
    fill(255);
    text("Players today:", panelX + 20, y);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    text(globalStats.isLoading ? "..." : globalStats.activeUsersToday, panelX + panelWidth - 20, y);
    y += lineHeight;

    // All-Time Games Played
    textAlign(LEFT, CENTER);
    fill(255);
    text("All-time games:", panelX + 20, y);
    textAlign(RIGHT, CENTER);
    fill(255, 215, 0);
    text(globalStats.isLoading ? "..." : globalStats.allTimeGames, panelX + panelWidth - 20, y);

    textAlign(CENTER, CENTER);
}

function drawGameHistoryContent(panelX, contentStartY, panelWidth, contentHeight) {
    if (gameHistory.length === 0) {
        textSize(18);
        fill(200);
        textAlign(CENTER, CENTER);
        text("No games played yet.", width / 2, contentStartY + contentHeight / 2);
        textAlign(CENTER, CENTER);
        return;
    }

    // Find max score to determine scale
    let maxScore = Math.max(...gameHistory);
    let maxYValue = Math.ceil(maxScore / 1000) * 1000; // Round up to nearest 1000
    if (maxYValue === 0) maxYValue = 1000; // Minimum scale

    // Graph dimensions (reduced margins since no axis labels)
    let graphMarginTop = 30;
    let graphMarginBottom = 20;
    let graphMarginLeft = 20;
    let graphMarginRight = 20;
    let labelSpace = 20; // Space needed for score label above bar (10px font + 10px padding)
    let graphWidth = panelWidth - graphMarginLeft - graphMarginRight;
    let graphHeight = contentHeight - graphMarginTop - graphMarginBottom - labelSpace;
    let graphX = panelX + graphMarginLeft;
    let graphY = contentStartY + graphMarginTop + labelSpace;

    // Title
    fill(255);
    textSize(16);
    textAlign(CENTER, CENTER);
    text("Last " + gameHistory.length + " Scores", width / 2, contentStartY + 20);

    // Draw Y-axis grid lines (no labels)
    stroke(60);
    strokeWeight(1);

    let numMarks = maxYValue / 1000;
    for (let i = 0; i <= numMarks; i++) {
        let y = graphY + graphHeight - (i / numMarks) * graphHeight;
        // Grid line
        line(graphX, y, graphX + graphWidth, y);
    }

    // Draw bars
    let barWidth = graphWidth / gameHistory.length;
    let barPadding = barWidth * 0.2;

    noStroke();
    for (let i = 0; i < gameHistory.length; i++) {
        let score = gameHistory[gameHistory.length - 1 - i]; // Reverse order (oldest to newest left to right)
        let barHeight = (score / maxYValue) * graphHeight;
        let barX = graphX + i * barWidth + barPadding / 2;
        let barY = graphY + graphHeight - barHeight;

        // Draw bars in white
        fill(255);

        rect(barX, barY, barWidth - barPadding, barHeight);

        // Draw score label above bar
        fill(255);
        textSize(10);
        textAlign(CENTER, CENTER);
        text(score, barX + (barWidth - barPadding) / 2, barY - 10);
    }

    // Draw X-axis
    stroke(150);
    strokeWeight(2);
    line(graphX, graphY + graphHeight, graphX + graphWidth, graphY + graphHeight);

    noStroke();
    textAlign(CENTER, CENTER);
}

function drawAchievementContent(panelX, contentStartY, panelWidth, contentHeight) {
    // Filter achievements by current subtab
    let subTab = currentSubTab.achievements;
    let filteredAchievements = ACHIEVEMENTS.filter(achievement => {
        if (subTab === "shape") {
            return achievement.type === "shapes";
        } else if (subTab === "score") {
            return achievement.type === "split" || achievement.type === "consecutive";
        } else if (subTab === "time") {
            return achievement.type === "time";
        } else {
            // "other" - includes special and any other types
            return achievement.type === "special" || (achievement.type !== "shapes" && achievement.type !== "split" && achievement.type !== "consecutive" && achievement.type !== "time");
        }
    });

    let isShapeTab = (subTab === "shape");
    let checkboxAreaHeight = isShapeTab ? 75 : 0; // Space for header text and "Show shapes" checkbox

    // Calculate total content height
    let totalHeight = 10 + checkboxAreaHeight;
    for (let achievement of filteredAchievements) {
        if (isShapeTab && achievement.shapes) {
            // Shapes tab: title + shapes
            let itemHeight = 25; // title
            let numShapes = achievement.shapes.length;
            let numRows = Math.ceil(numShapes / 6);
            itemHeight += 25 + (numRows * 52) + 15; // shapes area with new spacing
            totalHeight += itemHeight;
        } else {
            // Other tabs: just description
            totalHeight += 30; // description line
        }
    }

    // Clamp scroll position
    let maxScroll = Math.max(0, totalHeight - contentHeight);
    menuScrollY = Math.max(0, Math.min(menuScrollY, maxScroll));

    // Clip to content area
    push();
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(panelX, contentStartY, panelWidth, contentHeight);
    drawingContext.clip();

    // Achievement list with scroll offset
    textAlign(LEFT, CENTER);
    let y = contentStartY + 10 - menuScrollY;

    // Draw header and "Show shapes" checkbox at top of shape tab
    if (isShapeTab) {
        // Header text
        // fill(255);
        // textSize(16);
        // textAlign(LEFT, CENTER);
        // text("Collect shapes by collapsing groups of 5's!", panelX + 20, y + 10);
        
        // y += 30;
        
        let checkboxSize = 24;
        let checkboxX = panelX + panelWidth - 50;
        let checkboxY = y + 10;
        
        fill(255);
        textSize(16);
        textAlign(LEFT, CENTER);
        text("Show shapes on blank tiles:", panelX + 20, checkboxY);
        
        stroke(255);
        strokeWeight(2);
        noFill();
        rect(checkboxX, checkboxY - checkboxSize / 2, checkboxSize, checkboxSize, 4);
        
        if (settings.showShapes) {
            line(checkboxX + 4, checkboxY, checkboxX + 10, checkboxY + 6);
            line(checkboxX + 10, checkboxY + 6, checkboxX + 20, checkboxY - 6);
        }
        noStroke();
        
        y += 45;
    }

    if (filteredAchievements.length === 0) {
        fill(150);
        textSize(16);
        textAlign(CENTER, CENTER);
        text("No achievements in this category", width / 2, contentStartY + contentHeight / 2);
    }

    for (let achievement of filteredAchievements) {
        let data = achievementData[achievement.id];

        // Skip if completely out of view
        if (y > contentStartY + contentHeight + 100 || y < contentStartY - 100) {
            let itemHeight;
            let descLines = achievement.description.split('\n');
            let lineHeight = 20;
            if (isShapeTab && achievement.shapes) {
                itemHeight = descLines.length * lineHeight + 5;
                let numShapes = achievement.shapes.length;
                let numRows = Math.ceil(numShapes / 6);
                itemHeight += 25 + (numRows * 52) + 15;
            } else {
                itemHeight = descLines.length * lineHeight + 10;
            }
            y += itemHeight;
            continue;
        }

        if (isShapeTab && achievement.shapes) {
            // For shapes tab: show only description and shapes
            textSize(16);
            let descLines = achievement.description.split('\n');
            let lineHeight = 20;
            if (data.unlocked) {
                fill(255, 215, 0);
            } else {
                fill(200);
            }
            let prefix = data.unlocked ? "✓ " : "○ ";
            for (let i = 0; i < descLines.length; i++) {
                text((i === 0 ? prefix : "   ") + descLines[i], panelX + 20, y + i * lineHeight);
            }

            y += descLines.length * lineHeight + 5;

            // Draw shape requirements centered
            let shapeY = y + 15;
            let spacing = 52;

            // Use cached shape matching results
            let shapeMatched = cachedShapeMatches?.[achievement.id] || new Array(achievement.shapes.length).fill(false);

            let numShapes = achievement.shapes.length;
            let numRows = Math.ceil(numShapes / 6);

            for (let i = 0; i < numShapes; i++) {
                let shape = achievement.shapes[i];
                let row = Math.floor(i / 6);
                let col = i % 6;
                let shapesInThisRow = (row === numRows - 1) ? (numShapes % 6 || 6) : 6;
                let rowWidth = shapesInThisRow * spacing;
                let startX = width / 2 - rowWidth / 2 + spacing / 2;

                let fillColor = shapeMatched[i] ? 255 : 100;
                drawShape(shape, startX + col * spacing, shapeY + row * spacing, 9, fillColor);
            }

            // Calculate height based on number of rows
            y += 25 + (numRows * 52) + 15;
        } else {
            // For other tabs: show only checkmark and description
            textSize(16);
            let descLines = achievement.description.split('\n');
            let lineHeight = 20;
            if (data.unlocked) {
                fill(255, 215, 0);
            } else {
                fill(200);
            }
            let prefix = data.unlocked ? "✓ " : "○ ";
            for (let i = 0; i < descLines.length; i++) {
                text((i === 0 ? prefix : "   ") + descLines[i], panelX + 20, y + i * lineHeight);
            }

            y += descLines.length * lineHeight + 10;
        }
    }

    drawingContext.restore();
    pop();

    // Draw scroll indicator if needed
    if (maxScroll > 0) {
        fill(100);
        let scrollBarHeight = (contentHeight / totalHeight) * contentHeight;
        let scrollBarY = contentStartY + (menuScrollY / maxScroll) * (contentHeight - scrollBarHeight);
        rect(panelX + panelWidth - 8, scrollBarY, 4, scrollBarHeight, 2);
    }

    textAlign(CENTER, CENTER);
}

function calculateShapeMatches() {
    // Calculate shape matching results for all shape achievements
    cachedShapeMatches = {};

    let shapeAchievements = ACHIEVEMENTS.filter(a => a.type === "shapes");

    for (let achievement of shapeAchievements) {
        let remainingCreatedShapes = grid.polyominoList ? [...grid.polyominoList] : [];
        let shapeMatched = new Array(achievement.shapes.length).fill(false);

        for (let i = 0; i < achievement.shapes.length; i++) {
            let requiredShape = achievement.shapes[i];

            let matchIndex = remainingCreatedShapes.findIndex(createdShape =>
                shapesMatch(createdShape, requiredShape)
            );

            if (matchIndex !== -1) {
                shapeMatched[i] = true;
                remainingCreatedShapes.splice(matchIndex, 1);
            }
        }

        cachedShapeMatches[achievement.id] = shapeMatched;
    }
}

function drawSettingsContent(panelX, contentStartY, panelWidth, contentHeight) {
    let lineHeight = 45;
    let checkboxSize = 24;
    
    // Calculate total content height
    // 2 checkboxes (45 each) + 4 toggle groups (45 + 30 each = 75 each) + padding
    let totalHeight = 20 + lineHeight * 2 + (lineHeight + 30) * 4 + 20;
    
    // Clamp scroll position
    let maxScroll = Math.max(0, totalHeight - contentHeight);
    menuScrollY = Math.max(0, Math.min(menuScrollY, maxScroll));
    
    // Clip to content area
    push();
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(panelX, contentStartY, panelWidth, contentHeight);
    drawingContext.clip();
    
    let y = contentStartY + 20 - menuScrollY;
    let checkboxX = panelX + panelWidth - 50;

    // Disable Animation setting
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);
    text("Disable animation:", panelX + 20, y);

    // Draw checkbox
    stroke(255);
    strokeWeight(2);
    noFill();
    rect(checkboxX, y - checkboxSize / 2, checkboxSize, checkboxSize, 4);

    if (settings.disableAnimation) {
        // Draw checkmark
        line(checkboxX + 4, y, checkboxX + 10, y + 6);
        line(checkboxX + 10, y + 6, checkboxX + 20, y - 6);
    }
    noStroke();

    y += lineHeight;

    // Show shapes setting
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);
    text("Show shapes on blank tiles:", panelX + 20, y);

    // Draw checkbox
    stroke(255);
    strokeWeight(2);
    noFill();
    rect(checkboxX, y - checkboxSize / 2, checkboxSize, checkboxSize, 4);

    if (settings.showShapes) {
        // Draw checkmark
        line(checkboxX + 4, y, checkboxX + 10, y + 6);
        line(checkboxX + 10, y + 6, checkboxX + 20, y - 6);
    }
    noStroke();

    y += lineHeight;

    // Extra stat to display setting
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);
    text("Below score, show:", panelX + 20, y);

    y += 30;

    // Draw toggle options
    let options = [
        { id: "nothing", label: "Nothing" },
        { id: "moves", label: "Moves" },
        { id: "time", label: "Time" }
    ];

    let optionWidth = (panelWidth - 40) / options.length;
    for (let i = 0; i < options.length; i++) {
        let opt = options[i];
        let optX = panelX + 20 + i * optionWidth;
        let isSelected = settings.extraStat === opt.id;

        // Option background
        fill(isSelected ? 80 : 40);
        rect(optX, y - 15, optionWidth - 5, 30, 4);

        // Option text
        fill(isSelected ? 255 : 150);
        textSize(13);
        textAlign(CENTER, CENTER);
        text(opt.label, optX + (optionWidth - 5) / 2, y);
    }

    y += lineHeight;

    // Compare splits setting
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);
    text("Compare splits against:", panelX + 20, y);

    y += 30;

    // Draw toggle options for compare splits
    let splitOptions = [
        { id: "nothing", label: "Nothing" },
        { id: "pb", label: "PB" },
        { id: "dailypb", label: "Daily PB" },
        { id: "wr", label: "WR" },
        { id: "dailywr", label: "Daily WR" }
    ];

    let splitOptionWidth = (panelWidth - 40) / splitOptions.length;
    let splitButtonHeight = 50;
    for (let i = 0; i < splitOptions.length; i++) {
        let opt = splitOptions[i];
        let optX = panelX + 20 + i * splitOptionWidth;
        let isSelected = settings.compareSplits === opt.id;

        // Option background
        fill(isSelected ? 80 : 40);
        rect(optX, y - 15, splitOptionWidth - 5, splitButtonHeight, 4);

        // Option label
        fill(isSelected ? 255 : 150);
        textSize(11);
        textAlign(CENTER, CENTER);
        text(opt.label, optX + (splitOptionWidth - 5) / 2, y);
        
        // Score underneath (except for "Nothing")
        if (opt.id !== "nothing") {
            let score = comparisonScores[opt.id];
            fill(isSelected ? 200 : 120);
            textSize(10);
            text(score !== null ? score : "-", optX + (splitOptionWidth - 5) / 2, y + 16);
        }
    }

    y += splitButtonHeight + 5;

    // Challenge mode setting
    textAlign(LEFT, CENTER);
    fill(255);
    textSize(16);
    text("Challenge mode:", panelX + 20, y);

    y += 30;

    // Draw toggle options for challenge mode
    let challengeOptions = [
        { id: "none", label: "None" },
        { id: "bottomrow", label: "Bottom Row" },
        { id: "middlecolumn", label: "Middle Col" }
    ];

    let challengeOptionWidth = (panelWidth - 40) / challengeOptions.length;
    for (let i = 0; i < challengeOptions.length; i++) {
        let opt = challengeOptions[i];
        let optX = panelX + 20 + i * challengeOptionWidth;
        let isSelected = settings.challengeMode === opt.id;

        // Option background
        fill(isSelected ? 80 : 40);
        rect(optX, y - 15, challengeOptionWidth - 5, 30, 4);

        // Option text
        fill(isSelected ? 255 : 150);
        textSize(13);
        textAlign(CENTER, CENTER);
        text(opt.label, optX + (challengeOptionWidth - 5) / 2, y);
    }

    // Restore clipping
    drawingContext.restore();
    pop();
    
    // Draw scrollbar if content overflows
    if (totalHeight > contentHeight) {
        let scrollbarX = panelX + panelWidth - 8;
        let scrollbarHeight = contentHeight * (contentHeight / totalHeight);
        let scrollbarY = contentStartY + (menuScrollY / maxScroll) * (contentHeight - scrollbarHeight);
        
        fill(100, 150);
        noStroke();
        rect(scrollbarX, scrollbarY, 4, scrollbarHeight, 2);
    }

    textAlign(CENTER, CENTER);
}

function initializeSettings() {
    let savedSettings = getItem("settings");
    if (savedSettings !== null) {
        settings = { ...settings, ...savedSettings };
        // Migrate old "split" or "splitdiff" extraStat to "nothing" (it's now a separate setting)
        if (settings.extraStat === "split" || settings.extraStat === "splitdiff") {
            settings.extraStat = "nothing";
            // If they had splitdiff enabled, enable the new compareSplits setting
            if (!settings.compareSplits || settings.compareSplits === "nothing") {
                settings.compareSplits = "pb";
            }
            saveSettings();
        }
    }
}

function saveSettings() {
    storeItem("settings", settings);
}

// ============================================================================
// Event Handlers
// ============================================================================

// Helper function to check if a point is inside the menu panel
function isInsideMenuPanel(x, y) {
    let panelX = 15;
    let panelY = 95;
    let panelWidth = width - 30;
    let panelHeight = height - 110;
    return x >= panelX && x <= panelX + panelWidth &&
        y >= panelY && y <= panelY + panelHeight;
}

// Handle clicks outside the canvas to close menu
function handleDocumentClick(event) {
    if (!showMenu) return;

    // Check if click was inside the canvas
    let rect = canvas.elt.getBoundingClientRect();
    let clickX = event.clientX;
    let clickY = event.clientY;

    let insideCanvas = clickX >= rect.left && clickX <= rect.right &&
        clickY >= rect.top && clickY <= rect.bottom;

    // If click was outside canvas, close menu
    if (!insideCanvas) {
        showMenu = false;
        redraw();
    }
}

function onClick() {
    if (mouseY < 80) {
        // Header area - always accessible
        if (mouseX > width - 80) {
            // Reset button (top right)
            if (grid.gameOver || !grid.hasSplits || resetConfirmPending) {
                newGame();
                showMenu = false;
                cachedShapeMatches = null;
                resetConfirmPending = false;
                loop();
            } else {
                resetConfirmPending = true;
                resetConfirmTime = millis();
                loop();
            }
        } else if (mouseX < 80) {
            resetConfirmPending = false;
            // Menu toggle button (top left)
            showMenu = !showMenu;
            storeItem("showMenu", showMenu);

            // Handle data fetching when opening menu
            if (showMenu) {
                handleTabSwitch(currentMenuTab);
            }

            loop();
        } else {
            resetConfirmPending = false;
            // Click in score area (between menu and reset buttons)
            if (showMenu) {
                showMenu = false;
                storeItem("showMenu", showMenu);
            } else {
                // Cycle through extra stat options
                let options = ["nothing", "moves", "time"];
                let currentIndex = options.indexOf(settings.extraStat);
                settings.extraStat = options[(currentIndex + 1) % options.length];
                saveSettings();
                if (settings.extraStat === "time" && grid.firstMoveTime !== null) {
                    loop();
                }
            }
            loop();
        }
    } else {
        resetConfirmPending = false;
        if (showMenu) {
            // Check if click is inside the menu panel
            if (isInsideMenuPanel(mouseX, mouseY)) {
                // Click is inside menu panel - handle interactive elements

                // Check if clicking on main tabs
                let panelX = 15;
                let panelWidth = width - 30;
                let tabs = ["howtoplay", "leaderboards", "achievements", "stats", "settings"];
                let tabWidth = panelWidth / tabs.length;
                let tabY = 110;
                let tabHeight = 35;

                if (mouseY >= tabY && mouseY <= tabY + tabHeight) {
                    for (let i = 0; i < tabs.length; i++) {
                        let tabX = panelX + i * tabWidth;
                        if (mouseX >= tabX && mouseX < tabX + tabWidth) {
                            if (currentMenuTab !== tabs[i]) {
                                currentMenuTab = tabs[i];
                                storeItem("currentMenuTab", currentMenuTab);
                                menuScrollY = 0;
                                handleTabSwitch(tabs[i]);
                                loop();
                            }
                            redraw();
                            return;
                        }
                    }
                }

                // Check if clicking on subtabs
                let subTabY = tabY + tabHeight + 5;
                let subTabHeight = 28;
                let subtabs = null;

                if (currentMenuTab === "leaderboards") {
                    subtabs = ["alltime", "yesterday", "today"];
                } else if (currentMenuTab === "achievements") {
                    subtabs = ["score", "time", "shape", "other"];
                } else if (currentMenuTab === "stats") {
                    subtabs = ["thisgame", "personal", "global"];
                }

                if (subtabs && mouseY >= subTabY && mouseY <= subTabY + subTabHeight) {
                    let subTabWidth = (panelWidth - 20) / subtabs.length;
                    for (let i = 0; i < subtabs.length; i++) {
                        let subTabX = panelX + 10 + i * subTabWidth;
                        if (mouseX >= subTabX && mouseX < subTabX + subTabWidth) {
                            if (currentSubTab[currentMenuTab] !== subtabs[i]) {
                                currentSubTab[currentMenuTab] = subtabs[i];
                                storeItem("currentSubTab", currentSubTab);
                                menuScrollY = 0;
                                handleSubTabSwitch(currentMenuTab, subtabs[i]);
                                loop();
                            }
                            redraw();
                            return;
                        }
                    }
                }

                // Check if clicking Discord link on howtoplay tab
                if (currentMenuTab === "howtoplay" && discordLinkBounds) {
                    if (mouseX >= discordLinkBounds.x && mouseX <= discordLinkBounds.x + discordLinkBounds.width &&
                        mouseY >= discordLinkBounds.y && mouseY <= discordLinkBounds.y + discordLinkBounds.height) {
                        window.open(DISCORD_URL, '_blank');
                        return;
                    }
                }

                // Check if clicking "Show shapes" checkbox on achievements shape tab
                if (currentMenuTab === "achievements" && currentSubTab.achievements === "shape") {
                    let contentStartY = 110 + 35 + 28 + 10; // tabY + tabHeight + subTabHeight + padding
                    // y starts at contentStartY + 10, +10 for checkbox center
                    let checkboxY = contentStartY + 10 - menuScrollY + 10;
                    let checkboxX = panelX + panelWidth - 50;
                    let checkboxSize = 24;
                    let clickPadding = 15;
                    
                    if (mouseY >= checkboxY - checkboxSize / 2 - clickPadding && mouseY <= checkboxY + checkboxSize / 2 + clickPadding &&
                        mouseX >= checkboxX - clickPadding && mouseX <= checkboxX + checkboxSize + clickPadding &&
                        mouseY >= contentStartY) {
                        settings.showShapes = !settings.showShapes;
                        saveSettings();
                        redraw();
                        return;
                    }
                }

                // Check if clicking edit name button on leaderboard
                if (currentMenuTab === "leaderboards") {
                    let contentStartY = 110 + 35 + 28 + 10; // tabY + tabHeight + subTabHeight + padding
                    let contentHeight = (height - 110) - (contentStartY - 95);
                    let editButtonY = contentStartY + contentHeight - 20;

                    if (mouseY >= editButtonY - 10 && mouseY <= editButtonY + 10 &&
                        mouseX >= width - 120) {
                        promptForDisplayName();
                        return;
                    }
                }

                // Check if clicking settings checkboxes/options
                if (currentMenuTab === "settings") {
                    let contentStartY = 110 + 35 + 30; // tabY + tabHeight + title space
                    let y = contentStartY + 20 - menuScrollY;
                    let checkboxX = panelX + panelWidth - 50;
                    let checkboxSize = 24;
                    let lineHeight = 45;

                    // Only handle clicks within content area
                    if (mouseY >= contentStartY && mouseY <= contentStartY + (height - 110 - (contentStartY - 95))) {
                        // Disable animation checkbox - larger clickable area
                        let clickPadding = 15;
                        if (mouseY >= y - checkboxSize / 2 - clickPadding && mouseY <= y + checkboxSize / 2 + clickPadding &&
                            mouseX >= checkboxX - clickPadding && mouseX <= checkboxX + checkboxSize + clickPadding) {
                            settings.disableAnimation = !settings.disableAnimation;
                            saveSettings();
                            redraw();
                            return;
                        }

                        y += lineHeight;

                        // Show shapes checkbox
                        if (mouseY >= y - checkboxSize / 2 - clickPadding && mouseY <= y + checkboxSize / 2 + clickPadding &&
                            mouseX >= checkboxX - clickPadding && mouseX <= checkboxX + checkboxSize + clickPadding) {
                            settings.showShapes = !settings.showShapes;
                            saveSettings();
                            redraw();
                            return;
                        }

                        y += lineHeight + 30; // lineHeight + label spacing

                        // Extra stat options
                        let options = ["nothing", "moves", "time"];
                        let optionWidth = (panelWidth - 40) / options.length;
                        for (let i = 0; i < options.length; i++) {
                            let optX = panelX + 20 + i * optionWidth;
                            if (mouseX >= optX && mouseX <= optX + optionWidth - 5 &&
                                mouseY >= y - 15 && mouseY <= y + 15) {
                                settings.extraStat = options[i];
                                saveSettings();
                                if (options[i] === "time" && grid.firstMoveTime !== null) {
                                    loop();
                                }
                                redraw();
                                return;
                            }
                        }

                        y += lineHeight + 30; // lineHeight + label spacing

                        // Compare splits options
                        let splitOptions = ["nothing", "pb", "dailypb", "wr", "dailywr"];
                        let splitOptionWidth = (panelWidth - 40) / splitOptions.length;
                        let splitButtonHeight = 50;
                        for (let i = 0; i < splitOptions.length; i++) {
                            let optX = panelX + 20 + i * splitOptionWidth;
                            if (mouseX >= optX && mouseX <= optX + splitOptionWidth - 5 &&
                                mouseY >= y - 15 && mouseY <= y - 15 + splitButtonHeight) {
                                settings.compareSplits = splitOptions[i];
                                saveSettings();
                                // Fetch new comparison splits
                                fetchComparisonSplits(splitOptions[i]);
                                redraw();
                                return;
                            }
                        }

                        y += splitButtonHeight + 5 + 30; // button height + gap + label spacing

                        // Challenge mode options
                        let challengeOptions = ["none", "bottomrow", "middlecolumn"];
                        let challengeOptionWidth = (panelWidth - 40) / challengeOptions.length;
                        for (let i = 0; i < challengeOptions.length; i++) {
                            let optX = panelX + 20 + i * challengeOptionWidth;
                            if (mouseX >= optX && mouseX <= optX + challengeOptionWidth - 5 &&
                                mouseY >= y - 15 && mouseY <= y + 15) {
                                settings.challengeMode = challengeOptions[i];
                                saveSettings();
                                redraw();
                                return;
                            }
                        }
                    }
                }

                // Handle drag scrolling for scrollable tabs
                if (currentMenuTab === "howtoplay" || currentMenuTab === "achievements" ||
                    currentMenuTab === "settings" ||
                    (currentMenuTab === "stats" && (currentSubTab.stats === "personal" || currentSubTab.stats === "thisgame"))) {
                    menuDragStartY = mouseY;
                    menuDragStartScrollY = menuScrollY;
                }

                // Click inside menu panel on non-interactive area - do nothing (don't close)
                redraw();
                return;
            } else {
                // Click is outside menu panel - close menu
                showMenu = false;
            }
        } else {
            grid.click(mouseX, mouseY);
        }
    }
    redraw();
}

function handleTabSwitch(tabId) {
    // Handle data fetching when switching to a tab
    if (tabId === "leaderboards") {
        fetchLeaderboardData(currentSubTab.leaderboards);
    } else if (tabId === "achievements" && currentSubTab.achievements === "shape") {
        calculateShapeMatches();
    } else if (tabId === "stats") {
        if (currentSubTab.stats === "personal") {
            initializeGameHistory();
        } else if (currentSubTab.stats === "global") {
            fetchGlobalStats().then(() => loop());
        }
    } else if (tabId === "settings") {
        // Refetch comparison scores when opening settings
        fetchAllComparisonScores();
    }
}

function handleSubTabSwitch(tabId, subTabId) {
    // Handle data fetching when switching subtabs
    if (tabId === "leaderboards") {
        fetchLeaderboardData(subTabId);
    } else if (tabId === "achievements" && subTabId === "shape") {
        calculateShapeMatches();
    } else if (tabId === "stats") {
        if (subTabId === "personal") {
            initializeGameHistory();
        } else if (subTabId === "global") {
            fetchGlobalStats().then(() => loop());
        }
    }
}

function fetchLeaderboardData(subTabId) {
    if (subTabId === "alltime") {
        fetchTopScores(true).then(() => loop());
    } else if (subTabId === "today") {
        fetchTopScores(false).then(() => loop());
    } else if (subTabId === "yesterday") {
        fetchYesterdayScores().then(() => loop());
    }
}

function mouseMoved() {
    // Update cursor based on hover state

    if (showMenu && currentMenuTab === "howtoplay" && discordLinkBounds) {
        if (mouseX >= discordLinkBounds.x && mouseX <= discordLinkBounds.x + discordLinkBounds.width &&
            mouseY >= discordLinkBounds.y && mouseY <= discordLinkBounds.y + discordLinkBounds.height) {
            cursor(HAND);
            return;
        }
    }
    cursor(ARROW);
}

function isScrollableTab() {
    // Check if current tab/subtab combination is scrollable
    return showMenu && (
        currentMenuTab === "howtoplay" ||
        currentMenuTab === "achievements" ||
        currentMenuTab === "settings" ||
        (currentMenuTab === "stats" && (currentSubTab.stats === "personal" || currentSubTab.stats === "thisgame"))
    );
}

function mouseWheel(event) {
    // Handle scrolling in scrollable tabs
    if (isScrollableTab()) {
        menuScrollY += event.delta;
        redraw();
        return false; // Prevent default scrolling
    }
}

function mouseDragged() {
    // Handle drag scrolling in scrollable tabs
    if (isScrollableTab() && menuDragStartY !== null) {
        let deltaY = menuDragStartY - mouseY;
        menuScrollY = menuDragStartScrollY + deltaY;
        redraw();
        return false;
    }
}

function touchMoved() {
    // Handle touch scrolling in scrollable tabs (for p5.js touch events)
    if (isScrollableTab() && menuDragStartY !== null) {
        // Use touches array if available, otherwise fall back to mouseY
        let currentY = touches.length > 0 ? touches[0].y : mouseY;
        let deltaY = menuDragStartY - currentY;
        menuScrollY = menuDragStartScrollY + deltaY;
        redraw();
        return false;
    }
}

function mouseReleased() {
    // End drag scrolling
    if (menuDragStartY !== null) {
        menuDragStartY = null;
        menuDragStartScrollY = null;
    }
}

function keyPressed() {
    if (!debug) return
    // on keypresses 1-5, replace the box the cursor is hovering over (for debugging purposes)
    if (key >= '1' && key <= '5') {
        let [i, j] = grid.getCoordinates(mouseX, mouseY);
        if (i >= 0 && i < grid.w && j >= 0 && j < grid.h) {
            let box = grid[i][j];
            box.n = parseInt(key);
            box.shape = null;
            box.showShape = false;
            redraw();
        }
    }

    if (key == "u") {
        // undo
        if (grid.moves.length > 0) {
            let moves = grid.moves.slice(0, -1); // Remove last move
            grid = new NumberGrid(w, h, grid.seed, moves);
            redraw();
        }
    }
}

// ============================================================================
// Touch Event Handlers (for mobile devices)
// ============================================================================

function handleTouchStart(event) {
    if (!showMenu) return;

    let touch = event.touches[0];
    let rect = canvas.elt.getBoundingClientRect();
    let touchY = touch.clientY - rect.top;

    // Only handle scrolling for scrollable tabs in the scrollable area
    if (isScrollableTab() && touchY >= 95 && touchY <= height - 15) {
        menuDragStartY = touchY;
        menuDragStartScrollY = menuScrollY;
        // Don't prevent default yet - only prevent if user actually drags
    }
}

function handleTouchMove(event) {
    if (!showMenu) return;
    if (!isScrollableTab()) return;
    if (menuDragStartY === null) return;

    let touch = event.touches[0];
    let rect = canvas.elt.getBoundingClientRect();
    let touchY = touch.clientY - rect.top;

    let deltaY = menuDragStartY - touchY;

    // Only scroll and prevent default if moved more than 5 pixels
    if (Math.abs(deltaY) > 5) {
        menuScrollY = menuDragStartScrollY + deltaY;
        redraw();
        event.preventDefault(); // Prevent scrolling the page
    }
}

function handleTouchEnd(event) {
    // Only handle if we started tracking a potential scroll
    if (menuDragStartY !== null) {
        let wasDrag = false;

        if (event.changedTouches.length > 0) {
            let touch = event.changedTouches[0];
            let rect = canvas.elt.getBoundingClientRect();
            let touchY = touch.clientY - rect.top;
            let dragDistance = Math.abs(touchY - menuDragStartY);
            wasDrag = dragDistance > 5;

            // If it was a drag, prevent the click event from firing
            if (wasDrag) {
                event.preventDefault();
            }
            // If it was just a tap, let onClick handle it (don't close menu here)
        }

        menuDragStartY = null;
        menuDragStartScrollY = null;
    }
}

// ============================================================================
// Version Checking
// ============================================================================

function initializeVersionCheck() {
    // Get initial version from current page
    let metaTag = document.querySelector('meta[name="app-version"]');
    if (metaTag) {
        currentAppVersion = metaTag.content;
        console.log('App version:', currentAppVersion);
    }

    // Check for updates every 15 minutes
    setInterval(checkForNewVersion, 15 * 60 * 1000);
}

function checkForNewVersion() {
    // Fetch the current index.html to check version
    fetch(window.location.href, {
        cache: 'no-cache',
        headers: {
            'Cache-Control': 'no-cache'
        }
    })
        .then(response => response.text())
        .then(html => {
            // Parse the HTML to find the version meta tag
            let match = html.match(/<meta name="app-version" content="([^"]+)"/);
            if (match && match[1]) {
                let newVersion = match[1];
                if (currentAppVersion && newVersion !== currentAppVersion) {
                    console.log('New version detected:', newVersion, '(current:', currentAppVersion + ')');
                    // Silently set flag - will reload on next new game
                    newVersionAvailable = true;
                }
            }
        })
        .catch(error => {
            console.log('Version check failed:', error);
        });
}

// ============================================================================
// Statistics
// ============================================================================

function initializeStatistics() {
    // Load saved statistics from localStorage
    let savedStats = getItem("statistics");

    if (savedStats !== null) {
        // Merge saved stats with defaults to ensure new fields are present
        statistics = { ...statistics, ...savedStats };
    } else {
        // First time initialization - try to get personal best from database
        initializeStatisticsFromDatabase();
    }
}

async function initializeStatisticsFromDatabase() {
    // Try to get the user's all-time high score from Firebase
    if (currentUser && db) {
        try {
            const allTimeRef = db.collection('highscores').doc(currentUser.uid);
            const allTimeDoc = await allTimeRef.get();

            if (allTimeDoc.exists) {
                const dbScore = allTimeDoc.data().score;
                if (dbScore > statistics.personalBest) {
                    statistics.personalBest = dbScore;
                    saveStatistics();
                    console.log("Initialized personal best from database:", dbScore);
                }
            }
        } catch (error) {
            console.log("Could not fetch personal best from database:", error);
        }
    }
}

function saveStatistics() {
    storeItem("statistics", statistics);
}

function updateStatisticsLive(score, chains) {
    // Update statistics in real-time during gameplay (doesn't increment games played)
    // Update personal best
    if (score > statistics.personalBest) {
        statistics.personalBest = score;
        saveStatistics();
    }

    // Update largest chains for each tile type
    if (chains) {
        let updated = false;
        for (let tileType in chains) {
            if (chains[tileType] > statistics.largestChains[tileType]) {
                statistics.largestChains[tileType] = chains[tileType];
                updated = true;
            }
        }
        if (updated) {
            saveStatistics();
        }
    }

    // Track fastest times to reach score milestones
    if (typeof grid !== 'undefined' && grid && grid.firstMoveTime !== null) {
        let elapsed = Date.now() - grid.firstMoveTime;
        let updated = false;

        if (score >= 1000 && (statistics.fastestTo1000 === null || elapsed < statistics.fastestTo1000)) {
            statistics.fastestTo1000 = elapsed;
            updated = true;
        }
        if (score >= 3000 && (statistics.fastestTo3000 === null || elapsed < statistics.fastestTo3000)) {
            statistics.fastestTo3000 = elapsed;
            updated = true;
        }
        if (score >= 5000 && (statistics.fastestTo5000 === null || elapsed < statistics.fastestTo5000)) {
            statistics.fastestTo5000 = elapsed;
            updated = true;
        }
        if (score >= 7000 && (statistics.fastestTo7000 === null || elapsed < statistics.fastestTo7000)) {
            statistics.fastestTo7000 = elapsed;
            updated = true;
        }

        if (updated) {
            saveStatistics();
        }
    }
}

function updateStatistics(score, chains) {
    // Update statistics at game end (includes incrementing games played)
    updateStatisticsLive(score, chains);

    // Increment games played
    statistics.gamesPlayed++;

    // Update high score counts
    if (score >= 7000) statistics.gamesOver7000++;
    if (score >= 8000) statistics.gamesOver8000++;
    if (score >= 9000) statistics.gamesOver9000++;
    if (score >= 10000) statistics.gamesOver10000++;

    saveStatistics();

    // Increment global stats in Firebase
    if (typeof incrementGlobalStats === 'function') {
        incrementGlobalStats();
    }
}

function updatePersonalWorst(score) {
    // Update personal worst (only for games that ran out of moves)
    if (statistics.personalWorst == null || score < statistics.personalWorst) {
        statistics.personalWorst = score;
        saveStatistics();
    }
    
    // Check if game qualifies for challenge mode stats
    updateChallengeStats(score);
}

function updateChallengeStats(score) {
    // Check if the game was played without using the bottom row or middle column
    let usedBottomRow = false;
    let usedMiddleColumn = false;
    
    if (grid.positionHeatmap) {
        for (let i = 0; i < 5; i++) {
            if (grid.positionHeatmap[i][0] > 0) usedBottomRow = true;
            if (grid.positionHeatmap[2][i] > 0) usedMiddleColumn = true;
        }
    }
    
    // Update best score without bottom row
    if (!usedBottomRow) {
        if (statistics.bestWithoutBottomRow == null || score > statistics.bestWithoutBottomRow) {
            statistics.bestWithoutBottomRow = score;
            saveStatistics();
        }
    }
    
    // Update best score without middle column
    if (!usedMiddleColumn) {
        if (statistics.bestWithoutMiddleColumn == null || score > statistics.bestWithoutMiddleColumn) {
            statistics.bestWithoutMiddleColumn = score;
            saveStatistics();
        }
    }
}

function resetStatistics() {
    // Reset all statistics (for debugging)
    statistics = {
        personalBest: 0,
        personalWorst: null,
        bestWithoutBottomRow: null,
        bestWithoutMiddleColumn: null,
        largestChains: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        gamesPlayed: 0,
        fastestTo1000: null,
        fastestTo3000: null,
        fastestTo5000: null,
        fastestTo7000: null,
        gamesOver7000: 0,
        gamesOver8000: 0,
        gamesOver9000: 0,
        gamesOver10000: 0
    };
    saveStatistics();
    console.log("All statistics have been reset");
}

// ============================================================================
// Game History
// ============================================================================

function initializeGameHistory() {
    // Load saved game history from localStorage
    let savedHistory = getItem("gameHistory");

    if (savedHistory !== null) {
        gameHistory = savedHistory;
    }
}

function saveGameHistory() {
    storeItem("gameHistory", gameHistory);
}

function addToGameHistory(score) {
    // Refetch from localStorage to get any scores added from other tabs
    let savedHistory = getItem("gameHistory");
    if (savedHistory !== null) {
        gameHistory = savedHistory;
    }

    // Add score to beginning of history
    gameHistory.unshift(score);

    // Keep only last 7 scores
    if (gameHistory.length > 7) {
        gameHistory = gameHistory.slice(0, 7);
    }

    saveGameHistory();

    // Check consecutive score achievements (uses the updated gameHistory)
    checkConsecutiveScoreAchievements();
}

function resetGameHistory() {
    // Reset game history (for debugging)
    gameHistory = [];
    saveGameHistory();
    console.log("Game history has been reset");
}

function debugTestNotification(message = "Test Achievement Unlocked!") {
    // Debug function to test achievement notification display
    achievementNotification = message;
    achievementNotificationTime = Date.now();
    loop();
    console.log("Test notification triggered:", message);
}

function checkConsecutiveScoreAchievements() {
    // Check if last N games all meet the score threshold

    // 3000+ in 3 consecutive games
    if (gameHistory.length >= 3) {
        let last3 = gameHistory.slice(0, 3);
        if (last3.every(score => score >= 3000)) {
            unlockAchievement("consecutive_3000_x3");
        }
    }

    // 5000+ in 5 consecutive games
    if (gameHistory.length >= 5) {
        let last5 = gameHistory.slice(0, 5);
        if (last5.every(score => score >= 5000)) {
            unlockAchievement("consecutive_5000_x5");
        }
    }

    // 7000+ in 7 consecutive games
    if (gameHistory.length >= 7) {
        let last7 = gameHistory.slice(0, 7);
        if (last7.every(score => score >= 7000)) {
            unlockAchievement("consecutive_7000_x7");
        }
    }
}