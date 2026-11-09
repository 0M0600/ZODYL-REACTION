const express = require('express');
const cors = require('cors');
const path = require('path');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let sock = null;
let statutConnexion = "DÉCONNECTÉ";
let clientsReseau = [];

function envoyerStatutAuSite(donnees) {
    clientsReseau.forEach(client => client.res.write(`data: ${JSON.stringify(donnees)}\n\n`));
}

async function initWhatsAppSession() {
    const { state, saveCreds } = await useMultiFileAuthState('session_bot_reactions');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const raison = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            statutConnexion = "DÉCONNECTÉ";
            envoyerStatutAuSite({ statut: statutConnexion });
            if (raison) initWhatsAppSession();
        } else if (connection === 'open') {
            statutConnexion = "CONNECTÉ";
            envoyerStatutAuSite({ statut: statutConnexion });
            console.log('[✓] Instance connectée à l\'infrastructure WhatsApp.');
        }
    });
}
initWhatsAppSession();

// API pour demander le code de liaison officiel à 8 caractères
app.post('/api/demander-code-liaison', async (req, res) => {
    let { numero } = req.body;
    if (!numero) return res.status(400).json({ error: "Numéro de test manquant." });
    numero = numero.replace(/\s+/g, '').replace('+', '');

    try {
        statutConnexion = "GENERATION_CODE";
        envoyerStatutAuSite({ statut: statutConnexion });
        const codeLiaison = await sock.requestPairingCode(numero);
        statutConnexion = "ATTENTE_CODE";
        envoyerStatutAuSite({ statut: statutConnexion, code: codeLiaison });
        return res.json({ success: true, code: codeLiaison });
    } catch (err) {
        return res.status(500).json({ error: "WhatsApp refuse la liaison (sécurité anti-spam)." });
    }
});

// VRAIE ROUTE D'INJECTION SUR LA CHAÎNE WHATSAPP
app.post('/api/injecter-reactions', async (req, res) => {
    const { lien, emoji, quantite } = req.body;
    const qty = parseInt(quantite);

    if (qty > 50) {
        return res.status(429).json({ success: false, error: "Limite horaire dépassée (Maximum 50)." });
    }

    try {
        // Extraction de l'identifiant de la chaîne depuis l'URL
        const segmentsUrl = lien.split('/');
        const idCanalBrut = segmentsUrl[segmentsUrl.length - 1];
        if (!idCanalBrut) return res.status(400).json({ success: false, error: "Lien de chaîne invalide." });

        const jidCanal = `${idCanalBrut}@newsletter`;

        console.log(`[Réseau] Recherche du dernier message sur la newsletter : ${jidCanal}`);

        // REQUÊTE RÉSEAU : On demande à WhatsApp l'historique du canal pour trouver le dernier message
        const historique = await sock.fetchMessagesFromNewsletter({
            jid: jidCanal,
            count: 1
        });

        if (!historique || historique.length === 0) {
            return res.status(404).json({ success: false, error: "Aucun message trouvé dans cette chaîne pour appliquer la réaction." });
        }

        const dernierMessage = historique[0];
        const idMessageCible = dernierMessage.id; // Voici le VRAI Message ID cryptographique requis

        console.log(`[Réseau] Vrai ID trouvé : ${idMessageCible}. Envoi de la réaction...`);

        // ENVOI DE LA VRAIE RÉACTION
        await sock.sendMessage(jidCanal, {
            react: {
                text: emoji,
                key: {
                    remoteJid: jidCanal,
                    fromMe: false,
                    id: idMessageCible
                }
            }
        });

        return res.json({ success: true, message: "La vraie réaction a été injectée sur le dernier post !" });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, error: "Erreur réseau. Assurez-vous que le bot a rejoint ou a accès à cette chaîne publique." });
    }
});

app.get('/api/flux-statut', (req, res) => {
    res.setHeader('Content-Type': 'text/event-stream');
    res.setHeader('Cache-Control': 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const nouveauClient = { id: Date.now(), res };
    clientsReseau.push(nouveauClient);
    res.write(`data: ${JSON.stringify({ statut: statutConnexion })}\n\n`);
    req.on('close', () => { clientsReseau = clientsReseau.filter(c => c.id !== nouveauClient.id); });
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`[✓] Serveur Backend en ligne sur le port ${PORT}`); });



