/* ============================================================================
   FIREBASE-CONFIG.JS — configuração da sincronização com a nuvem (opcional)
   ----------------------------------------------------------------------------
   Enquanto "apiKey" estiver com COLE_AQUI, o sistema funciona só no aparelho
   (armazenamento local sem limite). Para ligar a nuvem:
     1) Console do Firebase > Configurações do projeto > Seus apps > Web (</>)
     2) Copie os valores do "firebaseConfig" e cole abaixo (apiKey, messagingSenderId, appId).
     3) Authentication > Sign-in method: ative o provedor Google.
     4) Cole as regras do arquivo regras-firebase.txt (com os e-mails liberados) no Firestore e no Storage.
     5) Salve este arquivo na MESMA pasta das páginas e publique de novo.
   ============================================================================ */
window.FIREBASE_CONFIG = {
    apiKey: 'COLE_AQUI',
    authDomain: 'sistema-integrado-d3bd9.firebaseapp.com',
    projectId: 'sistema-integrado-d3bd9',
    storageBucket: 'sistema-integrado-d3bd9.firebasestorage.app',
    messagingSenderId: 'COLE_AQUI',
    appId: 'COLE_AQUI'
};
