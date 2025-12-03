

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { GameCanvas } from './components/GameCanvas';
import { MainMenu } from './components/MainMenu';
import { GameOver } from './components/GameOver';
import { HUD } from './components/HUD';
import { Lobby } from './components/Lobby';
import { Leaderboard } from './components/Leaderboard';
import { SpectatorView } from './components/SpectatorView';
import { GameState, GameScore, RoomData } from './types';
import { STORAGE_KEY_HIGHSCORE, STORAGE_KEY_XP, STORAGE_KEY_LEVEL, GAME_DURATION_MS, INITIAL_LIVES, MAX_PLAYERS_PER_ROOM } from './constants';
import { audioManager } from './audio';

// Firebase imports
import { signInAnonymously } from 'firebase/auth';
import { doc, setDoc, onSnapshot, updateDoc, getDoc } from 'firebase/firestore';
import { db, auth } from './firebase';

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(GameState.MENU);
  const [score, setScore] = useState<GameScore>({ current: 0, best: 0, coins: 0, lives: INITIAL_LIVES });
  const [isMuted, setIsMuted] = useState(false);
  
  // Stats
  const [totalXP, setTotalXP] = useState(0);
  const [level, setLevel] = useState(1);
  const [earnedXP, setEarnedXP] = useState(0);

  // Multiplayer State
  const [userId, setUserId] = useState<string>('');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomData, setRoomData] = useState<RoomData | null>(null);
  const lastScoreSync = useRef(0);
  const [authError, setAuthError] = useState<string | null>(null);
  
  // Ref to track score without triggering effect re-runs
  const latestScoreRef = useRef<GameScore>(score);

  // Initialize Auth & Load Stats
  useEffect(() => {
    // Local Stats
    const savedBest = localStorage.getItem(STORAGE_KEY_HIGHSCORE);
    const savedXP = localStorage.getItem(STORAGE_KEY_XP);
    const savedLevel = localStorage.getItem(STORAGE_KEY_LEVEL);

    if (savedBest) setScore(prev => ({ ...prev, best: parseFloat(savedBest) }));
    if (savedXP) setTotalXP(parseInt(savedXP));
    if (savedLevel) setLevel(parseInt(savedLevel));

    // Auth
    signInAnonymously(auth)
      .then(cred => {
        setUserId(cred.user.uid);
      })
      .catch((err) => {
        console.warn("Firebase Auth failed (likely not enabled in console). using guest mode.", err);
        const guestId = 'guest_' + Math.random().toString(36).substring(2, 9);
        setUserId(guestId);
        setAuthError("Offline/Guest Mode");
      });
  }, []);

  // Update ref when score state changes
  useEffect(() => {
    latestScoreRef.current = score;
  }, [score]);

  // --- GAME ACTIONS DEFINED EARLY FOR USE IN EFFECT ---
  
  const handleGameOver = useCallback(async (finalScore: GameScore) => {
    // 1. Save Local Stats
    const xp = Math.floor(finalScore.current / 100) + (finalScore.coins * 2);
    setEarnedXP(xp);
    const newTotalXP = totalXP + xp;
    const newLevel = Math.floor(newTotalXP / 1000) + 1; 
    
    setTotalXP(newTotalXP);
    setLevel(newLevel);
    
    localStorage.setItem(STORAGE_KEY_XP, newTotalXP.toString());
    localStorage.setItem(STORAGE_KEY_LEVEL, newLevel.toString());

    if (finalScore.current > score.best) {
      localStorage.setItem(STORAGE_KEY_HIGHSCORE, finalScore.current.toString());
      setScore(prev => ({ ...prev, best: finalScore.current }));
    }

    // 2. Multiplayer Logic
    if (roomId && userId) {
       const roomRef = doc(db, 'rooms', roomId);
       
       // Determine status: Crashed (0 lives) or Finished (Time up)
       const status = finalScore.lives > 0 ? 'finished' : 'crashed';

       // IMMEDIATE: Update status in DB
       updateDoc(roomRef, {
           [`players.${userId}.score`]: finalScore.current,
           [`players.${userId}.status`]: status
       }).catch(console.error);
       
       // IMMEDIATE: Switch to Spectator View (The "Lobby" for ended players)
       setGameState(GameState.SPECTATING);
    } else {
      // Single player
      setGameState(GameState.GAME_OVER);
    }

  }, [roomId, userId, totalXP, score.best]);

  const startGame = useCallback((localOnly: boolean = true) => {
    audioManager.init();
    audioManager.startEngine();
    // Full Reset of Local State
    const initialScore = { current: 0, best: score.best, coins: 0, lives: INITIAL_LIVES };
    setScore(initialScore);
    latestScoreRef.current = initialScore;
    setEarnedXP(0); // Reset XP for new round
    
    setGameState(GameState.PLAYING);
  }, [score.best]);

  // --- ROOM LISTENER ---
  useEffect(() => {
    if (!roomId) {
      setRoomData(null);
      return;
    }

    // CRITICAL: This effect must NOT depend on 'score' state, otherwise it reconnects 60 times/sec.
    // Use latestScoreRef.current inside the callback instead.
    const unsub = onSnapshot(doc(db, 'rooms', roomId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as RoomData;
        setRoomData(data);
        
        // --- State Transitions triggered by Room Status ---
        
        // 1. Waiting -> Playing (Start Game / New Round)
        if (data.status === 'playing') {
          // Check my personal status in the DB.
          // If I am 'crashed' or 'finished', I must NOT restart, even if room is playing.
          const myPlayer = data.players[userId];
          
          if (myPlayer?.status === 'crashed') {
            // I am dead. Ensure I am waiting/spectating.
            // DO NOT TRIGGER startGame().
            if (gameState === GameState.PLAYING) {
               // If I think I'm playing but the server says I crashed, trust the server/handleGameOver logic.
               // (This block mostly prevents restarting if already spectating)
            }
          } else if (myPlayer?.status === 'playing' || myPlayer?.status === 'ready') {
             // I am eligible to play.
             // Only trigger start if I am NOT already playing.
             if (gameState === GameState.LOBBY || gameState === GameState.SPECTATING || gameState === GameState.GAME_OVER) {
                startGame(false);
             }
          }
        }

        // 2. Playing/Spectating -> Finished (Round End)
        // If the room is marked finished, everyone goes to Leaderboard
        if (data.status === 'finished') {
           if (gameState === GameState.PLAYING || gameState === GameState.SPECTATING) {
             // If I was still playing when time ran out, calculate my final stats now
             if (gameState === GameState.PLAYING) {
               // Force a game over locally to save stats, using REF for latest score
               handleGameOver(latestScoreRef.current); 
             } else {
               // I was already spectating, just move to results
               setGameState(GameState.GAME_OVER);
             }
           }
        }

        // 3. Finished -> Waiting (Host clicked "Return to Lobby" / "Restart Lobby")
        if (data.status === 'waiting') {
           if (gameState === GameState.GAME_OVER || gameState === GameState.SPECTATING) {
             setGameState(GameState.LOBBY);
           }
        }

        // --- Host Logic: Check if game should end ---
        if (userId && data.players[userId]?.isHost && data.status === 'playing') {
          // Check Time
          const timeIsUp = data.startTime && Date.now() - data.startTime > GAME_DURATION_MS;
          
          // Check if ALL players are crashed/finished
          const activePlayersCount = Object.values(data.players).filter(p => p.status === 'playing').length;
          
          // Only end if NO ONE is playing or TIME IS UP
          if (timeIsUp || activePlayersCount === 0) {
            updateDoc(docSnap.ref, { status: 'finished' });
          }
        }
      }
    }, (err) => {
      console.error("Room sync error:", err);
      setRoomId(null);
      setGameState(GameState.MENU);
    });

    return () => unsub();
  }, [roomId, gameState, userId, handleGameOver, startGame]); 

  // --- LOBBY ACTIONS ---

  const handleCreateRoom = async (playerName: string) => {
    if (!userId) return;
    const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const roomRef = doc(db, 'rooms', newRoomId);
    
    const newRoom: RoomData = {
      id: newRoomId,
      createdAt: Date.now(),
      status: 'waiting',
      players: {
        [userId]: {
          uid: userId,
          displayName: playerName,
          score: 0,
          isHost: true,
          status: 'ready'
        }
      }
    };

    try {
      await setDoc(roomRef, newRoom);
      setRoomId(newRoomId);
      setGameState(GameState.LOBBY);
    } catch (e) {
      console.error("Error creating room:", e);
      alert("Could not create room.");
    }
  };

  const handleJoinRoom = async (id: string, playerName: string) => {
    if (!userId) return;
    const roomRef = doc(db, 'rooms', id);
    
    try {
      const snap = await getDoc(roomRef);

      if (snap.exists()) {
        const data = snap.data() as RoomData;
        
        // Check Room Capacity
        const currentPlayers = Object.keys(data.players).length;
        if (currentPlayers >= MAX_PLAYERS_PER_ROOM) {
           alert("Room full wait for next round");
           return;
        }

        // Allow joining if waiting OR finished (between rounds)
        if (data.status === 'playing') {
          alert("Game in progress");
          return;
        }

        await updateDoc(roomRef, {
          [`players.${userId}`]: {
            uid: userId,
            displayName: playerName,
            score: 0,
            isHost: false,
            status: 'ready'
          }
        });
        setRoomId(id);
        setGameState(GameState.LOBBY);
      } else {
        alert("Room not found");
      }
    } catch (e) {
      console.error("Error joining room:", e);
    }
  };

  const handleStartMatch = async () => {
     if (!roomId || !roomData) return;
     try {
       const updates: any = {
         status: 'playing',
         startTime: Date.now()
       };
       // Reset EVERYONE for the new round
       Object.keys(roomData.players).forEach(pid => {
         updates[`players.${pid}.status`] = 'playing';
         updates[`players.${pid}.score`] = 0;
       });

       await updateDoc(doc(db, 'rooms', roomId), updates);
     } catch (e) {
       console.error("Error starting match:", e);
     }
  };

  const handleRestartLobby = async () => {
    if (!roomId || !roomData) return;
     try {
       // Reset room to waiting state so players can see the "Start" button again
       const updates: any = {
         status: 'waiting',
         startTime: null
       };
       Object.keys(roomData.players).forEach(pid => {
         updates[`players.${pid}.status`] = 'ready';
         updates[`players.${pid}.score`] = 0;
       });
       await updateDoc(doc(db, 'rooms', roomId), updates);
     } catch (e) {
       console.error("Error restarting lobby:", e);
     }
  };

  const handleLeaveRoom = () => {
    setRoomId(null);
    setGameState(GameState.MENU);
  };
  
  const handleEnterLobby = () => {
    setGameState(GameState.LOBBY);
  };

  // --- GAME ACTIONS ---

  const handleScoreUpdate = useCallback((newScore: GameScore) => {
    setScore(prev => ({ 
      ...prev, 
      current: newScore.current, 
      coins: newScore.coins,
      lives: newScore.lives
    }));
    latestScoreRef.current = newScore;
    
    const now = Date.now();
    if (roomId && userId && now - lastScoreSync.current > 2000) {
      const roomRef = doc(db, 'rooms', roomId);
      updateDoc(roomRef, {
        [`players.${userId}.score`]: newScore.current
      }).catch(console.error);
      lastScoreSync.current = now;
    }
  }, [roomId, userId]);

  const toggleMute = useCallback(() => {
    const newState = !isMuted;
    setIsMuted(newState);
    audioManager.setMuted(newState);
  }, [isMuted]);

  return (
    <div className="fixed inset-0 bg-black flex flex-col items-center justify-center overflow-hidden md:p-8">
      
      {/* Game Container */}
      <div 
        className="relative h-full w-full max-w-[500px] aspect-[9/16] shadow-2xl overflow-hidden bg-black md:rounded-lg md:border md:border-gray-800"
      >
        <GameCanvas 
          gameState={gameState} 
          onGameOver={handleGameOver} 
          onScoreUpdate={handleScoreUpdate}
          startTime={roomData?.startTime}
        />
        
        {gameState === GameState.PLAYING && (
          <HUD 
            score={score} 
            isMuted={isMuted} 
            onToggleMute={toggleMute}
            startTime={roomData?.startTime}
            roomData={roomData}
            currentUserId={userId}
          />
        )}
      </div>

      {/* Full Screen Overlays */}
      {gameState === GameState.MENU && (
        <MainMenu 
          onStart={handleEnterLobby} 
          bestScore={score.best} 
          userStats={{ level, xp: totalXP }}
          authError={authError}
        />
      )}

      {gameState === GameState.LOBBY && (
        <Lobby 
          currentRoom={roomData}
          currentUserId={userId}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          onStartMatch={handleStartMatch}
          onLeave={handleLeaveRoom}
        />
      )}

      {gameState === GameState.SPECTATING && roomData && (
        <SpectatorView 
          roomData={roomData}
          currentUserId={userId}
          startTime={roomData.startTime}
          onLeave={handleLeaveRoom}
        />
      )}

      {gameState === GameState.GAME_OVER && roomId && roomData ? (
        <Leaderboard 
            players={Object.values(roomData.players)} 
            currentUserId={userId}
            onLeave={handleEnterLobby} // Go back to Lobby UI to wait/ready up
            onRestartLobby={handleRestartLobby}
            isHost={roomData.players[userId]?.isHost}
            xpEarned={earnedXP}
        />
      ) : gameState === GameState.GAME_OVER && (
        <GameOver 
          score={score} 
          onRestart={() => startGame(true)} 
          onMenu={() => setGameState(GameState.MENU)} 
        />
      )}
      
    </div>
  );
};

export default App;
