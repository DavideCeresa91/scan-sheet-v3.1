// Barcode Bipper — configurazione pubblica del frontend.
//
// Solo BACKEND_ENDPOINT va impostato dall'amministratore del sito.
// Non inserire mai qui il client secret OAuth, refresh token o altri segreti server-side.
//
// Se stai aggiornando Scan Sheet v3.1 sullo STESSO browser e nello STESSO percorso,
// Barcode Bipper può migrare automaticamente il vecchio endpoint salvato in locale.
export const APP_CONFIG = Object.freeze({
  backendEndpoint: 'https://script.google.com/macros/s/AKfycbyhugJWaNMhPZMF_e2STNGk3WOVRi6GlU5_z_ky11-flR_8gMSMpl6kCqlF6ehBo34/exec',
  google: Object.freeze({
    // Browser API key già prevista dalla v3.1: deve restare limitata ai referrer e alle API necessarie.
    apiKey: 'AIzaSyCpwFf0y2gjUKmYa-ySG_Ab1QuB0XcrtGc',
    appId: '1039600601043'
  })
});

export const OAUTH_REDIRECT_URI = new URL('./oauth-callback.html', import.meta.url).href;
