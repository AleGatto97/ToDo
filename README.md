# TODO UNIFI

To-do list di lavoro a struttura piramidale, sincronizzata in tempo reale su tutti i dispositivi.

```
Progetto (macrocategoria)
  |- Task dirette di progetto
  |- Attività
       |- Task
```

File statici, nessuna build, nessuna dipendenza da installare: si pubblica su GitHub Pages
così com'è, e da lì si installa come app su iPhone, Mac e Android.

---

## Come si usa

| Azione | Come |
|---|---|
| Rinominare un progetto, un'attività o una task | Clicca sul testo, scrivi, premi **Invio**. **Esc** annulla. |
| Cambiare priorità a una task | Clicca sull'etichetta della priorità e scegli dal menu. |
| Riordinare progetti e attività | Trascina dalla **maniglia a puntini**. Funziona anche col dito su telefono e tablet. |
| Recuperare una task spuntata per sbaglio | Togli la spunta entro 5 secondi: la barra rossa è il countdown. |
| Backup | Pulsante **Dati** -> Scarica backup / Importa. |

Le task sono sempre ordinate per priorità decrescente. Un'attività può essere riordinata
solo dentro il proprio progetto.

---

## Sincronizzazione in tempo reale

Con un database Firebase collegato, ogni modifica compare **all'istante** su tutti i
dispositivi che hanno la pagina aperta: niente ricariche, niente pulsante "sincronizza".
Se la rete cade, l'app continua a funzionare in locale e riallinea tutto al ritorno.

### Setup Firebase (gratuito, una volta sola)

Il database è già creato. Restano tre cose da fare nella console, una volta sola.

**A. Registra un'app web** (serve per l'autenticazione)

1. Console Firebase -> icona ingranaggio -> **Impostazioni progetto**.
2. In fondo, sezione **Le tue app**, clicca l'icona **</>** (Web).
3. Nickname qualsiasi (es. `todo`), **non** attivare Firebase Hosting, **Registra app**.
4. Compare un blocco di codice: ti servono solo due valori, `apiKey` e `authDomain`.
5. Incollali in cima ad `app.js`:

   ```js
   const FIREBASE_DEFAULTS = {
     apiKey: 'AIza...',
     authDomain: 'todo-unifi.firebaseapp.com',
     databaseURL: 'https://todo-unifi-default-rtdb.europe-west1.firebasedatabase.app',
     workspaceKey: 'gatto-n51m791ngms786j3sfn8',
     authEmail: 'todo-unifi@todo-unifi.app'
   };
   ```

   > `apiKey` non è una password: Google la progetta per stare nel codice pubblico.
   > Identifica il progetto, non autorizza nulla. Ciò che autorizza sono le regole.

**B. Crea l'utenza con la password**

6. Menu a sinistra -> **Build** -> **Authentication** -> **Inizia**.
7. Scheda **Sign-in method** -> **Email/Password** -> attiva il primo interruttore
   (lascia spento "Link email") -> **Salva**.
8. Scheda **Users** -> **Aggiungi utente**:
   - Email: `todo-unifi@todo-unifi.app`
   - Password: quella che vorrai digitare nell'app
   - **Aggiungi utente**

   > Quell'indirizzo non è una casella vera e non riceverà mai nulla: Firebase pretende
   > un'email come identificativo, e l'app la compila da sola. Tu vedi solo il campo
   > password. Deve essere identico ad `authEmail` in `app.js`.
   >
   > Se un giorno dimentichi la password: console -> Authentication -> Users -> elimina
   > l'utente e ricrealo con una nuova password. I dati non si toccano.

**C. Chiudi il database a chi non ha fatto l'accesso**

9. **Realtime Database** -> scheda **Regole** -> sostituisci tutto con questo -> **Pubblica**:

   ```json
   {
     "rules": {
       "workspaces": {
         "gatto-n51m791ngms786j3sfn8": {
           ".read": "auth != null && auth.uid === 'IL-TUO-UID'",
           ".write": "auth != null && auth.uid === 'IL-TUO-UID'"
         }
       }
     }
   }
   ```

   Sostituisci `IL-TUO-UID` con l'identificativo che trovi in **Authentication -> Users**,
   nella colonna "Identificativo utente" della riga `todo-unifi@todo-unifi.app`.

   > **Perché il UID e non il più semplice `auth != null`.** Con `auth != null` basta
   > *un* utente qualsiasi del progetto. Ma l'apiKey è pubblica e il metodo
   > Email/Password è attivo: chiunque può chiamare l'endpoint di registrazione di
   > Firebase e crearsi un account nel tuo progetto, ritrovandosi autenticato e quindi
   > dentro i tuoi dati. Indicando il UID, l'unico account che il database accetta è
   > il tuo, e gli eventuali account creati da altri non servono a niente.
   >
   > Se cambi `workspaceKey` in `app.js`, cambialo anche qui. Se ricrei l'utente
   > (es. password dimenticata), il UID cambia: aggiorna le regole.

**Fatto.** Apri la pagina: compare la schermata con il campo password. Entri una volta
per dispositivo e resti dentro, anche riavviando il browser. Per uscire da un
dispositivo: pulsante **Cloud Sync** -> **Esci**.

In alternativa ai valori scritti in `app.js`, puoi lasciarli vuoti e inserirli dal
pulsante **Cloud Sync** su ogni dispositivo.

### Il badge di stato

| Badge | Significato |
|---|---|
| **Solo locale** | Nessun cloud configurato: i dati restano su questo dispositivo. |
| **Accesso richiesto** | Serve la password. |
| **Connessione...** | Sta agganciando il database. |
| **Sincronizzato** | Tutto allineato, in tempo reale. |
| **Offline** | Rete assente: le modifiche partono appena torna. |
| **Errore sync** | Configurazione incompleta o regole che rifiutano. Passaci sopra col mouse per il dettaglio. |

### L'avviso di GitHub sulla "Google API Key"

Appena carichi il codice, GitHub ti manda una mail: *"Possible valid secrets detected -
Google API Key"*. **Non è un problema.** Il rilevatore di GitHub segnala qualunque chiave
Google, senza distinguere i casi.

La documentazione Firebase è esplicita: le chiavi API dei servizi Firebase sono pensate
per stare nel codice, identificano il progetto e **non controllano l'accesso ai dati**.
Quello lo fanno le regole di sicurezza. Non c'è niente da revocare o rigenerare.

Puoi chiudere l'avviso dalla scheda **Security** del repository, indicando che
l'esposizione è intenzionale.

L'unica raccomandazione di Google che vale la pena seguire, se un domani attiverai altri
servizi Google sullo stesso progetto: nella Google Cloud Console, limita la chiave alle
sole API di Firebase. Con il solo Realtime Database e l'autenticazione non è necessario.

### Sicurezza

Con l'accesso attivo, il repository può restare pubblico senza problemi: `apiKey`,
`authDomain`, URL del database e nome del workspace **non sono segreti** ed è normale
che stiano nel codice del browser. L'unica cosa che apre i dati è la password, che non
è scritta da nessuna parte nel repository.

Regole d'oro:

- Non scrivere mai la password dentro `app.js` o in qualunque altro file del repository.
- Usa una password che non usi altrove.
- Se pensi che sia trapelata, cambiala dalla console (Authentication -> Users) e chi
  aveva la vecchia è fuori. Questo e il vantaggio vero rispetto alla protezione con un
  percorso segreto: la revoca è immediata e non tocca né il codice né gli altri dispositivi.
- Il backup JSON dalla finestra **Dati** resta la rete di sicurezza contro gli errori tuoi.

---

## Installarla come app

L'app è una PWA: si installa dalla pagina web, senza App Store e senza account sviluppatore.
Serve che sia aperta da **GitHub Pages** (https), non dal file locale.

**iPhone e iPad.** Apri la pagina in **Safari** (non Chrome: su iOS solo Safari può
installare), tocca il pulsante **Condividi** e poi **Aggiungi a schermata Home**. Comparirà
l'icona blu con il nome "ToDo".

> Se avevi già un vecchio segnalibro sulla Home, **eliminalo e rifallo**: quello vecchio è
> stato salvato prima che esistessero l'icona e il manifest, e resta com'era.

**Mac.** In Safari: menu **File -> Aggiungi al Dock**. In Chrome: icona di installazione
nella barra degli indirizzi. L'app compare nel Launchpad e in Cmd-Tab come le altre.

**Android.** Chrome propone da solo "Installa app", oppure menu -> Installa.

Cosa cambia rispetto al segnalibro: icona e nome propri, nessuna barra del browser,
schermata di avvio, e soprattutto **si apre anche senza rete** — vedi i tuoi progetti
dall'ultima volta, li modifichi, e appena torni online tutto si sincronizza.

### Aggiornamenti

Il service worker usa la strategia "prima la rete": quando carichi una versione nuova su
GitHub, al primo avvio online l'app la scarica e la usa. Non resti mai con la versione
vecchia. Se cambi molto e vuoi essere certo di aver buttato la cache, alza il numero in
`sw.js` alla riga `const CACHE = 'todo-unifi-v1'`.

### Un limite di iOS da conoscere

Se non apri l'app per diverse settimane, iOS può cancellare i dati che tiene in locale.
I progetti non si perdono, perché stanno su Firebase e vengono riscaricati. Può però
sparire la sessione di accesso: in quel caso ti richiederà la password. Non è un guasto.

---

## Come funziona la sincronizzazione (per riferimento futuro)

Il punto delicato di una lista condivisa è non perdere modifiche fatte in contemporanea.
Due scelte lo evitano:

**1. Scritture granulari.** Non viene mai inviato tutto l'albero dei dati. Se rinomini un
progetto parte solo `projects/<id>/name`. Se sposti un'attività parte solo il suo `order`.
Due dispositivi che modificano cose diverse non si toccano mai. L'ultima scrittura vince
solo sullo stesso identico campo.

**2. Ordinamento frazionario.** Ogni progetto e ogni attività hanno un campo `order`
numerico. Spostare un elemento fra altri due scrive un solo valore: la media dei due vicini
(1000 e 2000 diventa 1500). Non serve rinumerare la lista, quindi un riordino è una scrittura
sola invece di N. Quando lo spazio fra due valori si esaurisce, la lista viene rinumerata in
automatico.

Struttura sul database:

```
workspaces/<workspaceKey>/
  updatedAt: <timestamp>
  projects/
    <projectId>/
      id, name, order
      tasks/<taskId>/       -> id, name, priority (1-5), completed, createdAt
      activities/<activityId>/
        id, name, order
        tasks/<taskId>/     -> id, name, priority, completed, createdAt
```

Ogni dispositivo tiene una copia in `localStorage` (chiave `todo_unifi_workspace_v3`), che
serve da cache per l'apertura istantanea e da rete di sicurezza se il cloud non risponde.
I dati del vecchio formato (`todo_unifi_workspace_v2`, con gli array) vengono convertiti in
automatico al primo avvio.

---

## File

| File | Contenuto |
|---|---|
| `index.html` | Struttura della pagina e modali |
| `styles.css` | Design system completo |
| `app.js` | Logica, sincronizzazione, accesso, drag & drop, editing inline |
| `manifest.json` | Scheda d'identità dell'app installata (nome, icone, colori) |
| `sw.js` | Service worker: apertura senza rete e aggiornamenti |
| `icon-*.png`, `apple-touch-icon.png` | Icone dell'app installata |

## Compatibilità

Chrome, Safari, Firefox ed Edge aggiornati, su desktop e mobile. Il drag & drop usa i Pointer
Events, quindi funziona con mouse, dito e penna.
