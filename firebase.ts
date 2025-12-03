
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyDLO27Kem0lLpVdBnCnRXZg4w7GNZPCsEY",
  authDomain: "my-server-a7b7.firebaseapp.com",
  projectId: "my-server-a7b7",
  storageBucket: "my-server-a7b7.firebasestorage.app",
  messagingSenderId: "131436092362",
  appId: "1:131436092362:web:9bc91e773722d1714d8d33"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
