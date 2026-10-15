/* ============================================================================
   NUVEM.JS — sincronização opcional com o Firebase (Firestore + Storage)
   ----------------------------------------------------------------------------
   Só é carregado pelo armazem.js quando o firebase-config.js está preenchido.
   - Login com a conta Google (botão "ENTRAR" no canto da tela). Só e-mails liberados nas regras do Firebase têm acesso.
   - Rascunhos, listas e históricos (dados leves) -> Firestore: usuarios/{uid}/dados/{chave}
   - PDFs -> Storage: usuarios/{uid}/pdfs/{arquivo}.pdf
   - Dados maiores que ~300 mil caracteres vão para o Storage (limite de 1 MiB por documento do Firestore).
   - Ao abrir a página: baixa o que for mais novo na nuvem e envia o que for mais novo aqui.
   ============================================================================ */
(function () {
    'use strict';
    var A = window.Armazem, cfg = window.FIREBASE_CONFIG;
    if (!A || !cfg || A.nuvem) return;

    var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
    var LIMITE_DOC = 300000;
    var FLAG_RELOAD = 'armazem_recarregou';
    var PADRAO = A._i.padraoChaves, PADRAO_HIST = A._i.padraoHist;

    var auth, db, st, usuario = null, pend = new Set(), timer = null;
    var bloqueios = new Set();        // uploads de PDF em andamento
    var blobsFalhos = new Map();      // bk -> blob que falhou ao enviar
    var resolverLogin, loginP = new Promise(function (ok) { resolverLogin = ok; });
    var estado = 'iniciando';         // iniciando | offline | deslogado | sincronizando | ok | atualizar | erro
    var badge = null;

    function carregarJs(src) {
        return new Promise(function (ok, erro) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = ok;
            s.onerror = function () { erro(new Error('falha ao carregar ' + src)); };
            document.head.appendChild(s);
        });
    }

    function idDoc(k) { return encodeURIComponent(k); }
    function colecao() { return db.collection('usuarios').doc(usuario.uid).collection('dados'); }
    function caminhoDados(k) { return 'usuarios/' + usuario.uid + '/dados/' + idDoc(k) + '.json'; }
    function caminhoPdf(bk) { return 'usuarios/' + usuario.uid + '/pdfs/' + idDoc(bk) + '.pdf'; }
    function chaveValida(k) { return PADRAO.test(k) && k.indexOf('__') !== 0; }

    /* ------------------------------ Botão de status ------------------------------ */
    function criarBadge() {
        badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'no-print';
        badge.setAttribute('style',
            'position:fixed;left:12px;bottom:12px;z-index:40;padding:6px 12px;border-radius:999px;border:0;' +
            'background:#0f172a;color:#fff;font:700 11px/1.2 system-ui,Segoe UI,sans-serif;text-transform:uppercase;' +
            'letter-spacing:.04em;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;opacity:.92');
        badge.addEventListener('click', aoClicarBadge);
        document.body.appendChild(badge);
        atualizarBadge();
    }

    function atualizarBadge() {
        if (!badge) return;
        var txt = {
            iniciando: '☁ CONECTANDO...',
            offline: '☁ SEM CONEXÃO',
            deslogado: '☁ ENTRAR PARA SINCRONIZAR',
            sincronizando: '☁ SINCRONIZANDO...',
            ok: '☁ SINCRONIZADO',
            atualizar: '☁ DADOS NOVOS — TOQUE PARA ATUALIZAR',
            erro: '☁ ERRO NA SINCRONIZAÇÃO',
            negado: '☁ ACESSO NÃO LIBERADO'
        }[estado] || '☁';
        badge.textContent = txt;
        badge.style.background = estado === 'ok' ? '#166534' : (estado === 'erro' || estado === 'offline' || estado === 'negado') ? '#991b1b' : (estado === 'atualizar' ? '#b45309' : '#0f172a');
    }

    function definirEstado(e) { estado = e; atualizarBadge(); }

    function traduzirErro(err) {
        var c = (err && err.code) || '';
        if (/popup-blocked/.test(c)) return 'O NAVEGADOR BLOQUEOU A JANELA DO GOOGLE. PERMITA POP-UPS PARA ESTE SITE E TENTE DE NOVO.';
        if (/network/.test(c)) return 'SEM CONEXÃO COM A INTERNET.';
        if (/unauthorized-domain/.test(c)) return 'ESTE ENDEREÇO NÃO ESTÁ AUTORIZADO NO FIREBASE (AUTHORIZED DOMAINS).';
        return 'NÃO FOI POSSÍVEL ENTRAR COM O GOOGLE.';
    }

    function avisar(titulo, msg, icone) {
        if (typeof Swal === 'undefined') { alert(msg); return; }
        Swal.fire({
            icon: icone || 'warning',
            title: titulo,
            html: '<span class="text-amber-500 font-bold">ATENÇÃO:</span> ' + msg,
            confirmButtonColor: '#000000',
            returnFocus: false
        });
    }

    function aoClicarBadge() {
        if (estado === 'atualizar') { location.reload(); return; }
        if (estado === 'negado') { auth.signOut(); return; }   // permite escolher outra conta Google
        if (!usuario) { abrirLogin(); return; }
        if (typeof Swal === 'undefined') { if (confirm('SAIR DA SINCRONIZAÇÃO?')) auth.signOut(); return; }
        Swal.fire({
            title: 'SINCRONIZAÇÃO ATIVA',
            html: '<span class="text-amber-500 font-bold">CONTA:</span> ' + String(usuario.email || '').toUpperCase() +
                  '<br><br>SEUS DADOS SÃO SALVOS NO APARELHO E NA NUVEM.',
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonText: 'SINCRONIZAR AGORA',
            denyButtonText: 'SAIR',
            cancelButtonText: 'FECHAR',
            confirmButtonColor: '#000000',
            denyButtonColor: '#ef4444',
            cancelButtonColor: '#6b7280',
            returnFocus: false
        }).then(function (r) {
            if (r.isConfirmed) sincronizar();
            else if (r.isDenied) auth.signOut();
        });
    }

    function abrirLogin() {
        var prov = new firebase.auth.GoogleAuthProvider();
        prov.setCustomParameters({ prompt: 'select_account' });
        return auth.signInWithPopup(prov).catch(function (err) {
            if (err && /popup-closed-by-user|cancelled-popup-request/.test(err.code || '')) return;
            console.warn('[Nuvem] login', err);
            avisar('NÃO FOI POSSÍVEL ENTRAR', traduzirErro(err), 'error');
        });
    }

    function acessoNegado() {
        var email = String((usuario && usuario.email) || '').toUpperCase();
        definirEstado('negado');
        avisar('ACESSO NÃO LIBERADO',
            'O E-MAIL <span class="text-red-500 font-bold">' + email + '</span> NÃO ESTÁ NA LISTA DE USUÁRIOS AUTORIZADOS. ' +
            'SEUS DADOS CONTINUAM SALVOS NESTE APARELHO. FALE COM O ADMINISTRADOR PARA LIBERAR O ACESSO.', 'error');
    }

    /* ------------------------------ Envio ------------------------------ */
    function agendar(k) {
        if (!chaveValida(k)) return;
        pend.add(k);
        clearTimeout(timer);
        timer = setTimeout(descarregar, 1500);
    }

    function aguardarBlobs() {
        var lista = Array.from(bloqueios);
        return Promise.all(lista).then(function () {
            if (blobsFalhos.size) throw new Error('há PDFs que ainda não foram enviados');
        });
    }

    function enviarBlob(bk, blob) {
        var p = loginP.then(function () {
            return st.ref(caminhoPdf(bk)).put(blob, { contentType: 'application/pdf' });
        }).then(function () { blobsFalhos.delete(bk); }, function (e) {
            blobsFalhos.set(bk, blob);
            console.warn('[Nuvem] falha ao enviar PDF', e);
        });
        bloqueios.add(p);
        p.then(function () { bloqueios.delete(p); });
        return p;
    }

    function reenviarFalhos() {
        var itens = Array.from(blobsFalhos.entries());
        return Promise.all(itens.map(function (par) { return enviarBlob(par[0], par[1]); }));
    }

    function removerBlob(bk) {
        return loginP.then(function () { return st.ref(caminhoPdf(bk)).delete(); }).catch(function () {});
    }

    function baixarBlob(bk) {
        if (!usuario) return Promise.reject(new Error('não conectado'));
        return st.ref(caminhoPdf(bk)).getDownloadURL().then(function (url) {
            return fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); });
        });
    }

    function enviar(k) {
        var v = A.ls.getItem(k), t = A._i.tempo(k) || Date.now();
        var ref = colecao().doc(idDoc(k));
        if (v === null) return ref.set({ chave: k, removido: true, t: t });
        var hist = PADRAO_HIST.test(k);
        return (hist ? reenviarFalhos().then(aguardarBlobs) : Promise.resolve()).then(function () {
            var doc = { chave: k, t: t, removido: false, valor: v, grande: false };
            if (hist) doc.excluidos = Array.from(A._i.excluidos(k));
            if (v.length > LIMITE_DOC) {
                return st.ref(caminhoDados(k)).putString(v, 'raw', { contentType: 'application/json' }).then(function () {
                    doc.valor = null; doc.grande = true;
                    return ref.set(doc);
                });
            }
            return ref.set(doc);
        });
    }

    function descarregar() {
        if (!usuario || !pend.size) return Promise.resolve();
        var chaves = Array.from(pend);
        pend.clear();
        return Promise.all(chaves.map(function (k) {
            return enviar(k).catch(function (e) { pend.add(k); console.warn('[Nuvem] falha ao enviar', k, e); throw e; });
        })).then(function () { if (estado !== 'atualizar') definirEstado('ok'); }, function (e) {
            if (e && e.code === 'permission-denied') { pend.clear(); if (estado !== 'negado') acessoNegado(); return; }
            definirEstado(navigator.onLine ? 'erro' : 'offline');
        });
    }

    /* ------------------------------ Recebimento / mesclagem ------------------------------ */
    function valorRemoto(k, r) {
        if (!r.grande) return Promise.resolve(r.valor);
        return st.ref(caminhoDados(k)).getDownloadURL().then(function (url) { return fetch(url).then(function (x) { return x.text(); }); });
    }

    function mesclarHistorico(k, r) {
        var local = A._i.lerLista(k);
        var obterRemoto = (!r.removido && (r.valor || r.grande)) ? valorRemoto(k, r) : Promise.resolve('[]');
        return obterRemoto.then(function (txt) {
            var remotoArr; try { remotoArr = JSON.parse(txt); } catch (_) { remotoArr = []; }
            if (!Array.isArray(remotoArr)) remotoArr = [];
            var exclR = new Set((r.excluidos || []).map(String));
            var exclL = A._i.excluidos(k);
            var exclTodos = new Set(Array.from(exclR).concat(Array.from(exclL)));
            var idsLocal = new Set(local.map(function (i) { return String(i.id); }));
            var idsRemoto = new Set(remotoArr.map(function (i) { return String(i.id); }));

            var resultado = local.filter(function (i) { return !exclR.has(String(i.id)); });
            var alterou = resultado.length !== local.length;
            remotoArr.forEach(function (i) {
                var id = String(i.id);
                if (!idsLocal.has(id) && !exclTodos.has(id)) { resultado.push(i); alterou = true; }
            });

            A._i.addExcluidos(k, Array.from(exclR));
            if (alterou) A._i.gravarRemoto(k, JSON.stringify(resultado), Date.now());

            // itens que só existem aqui: sobe o PDF e depois a lista
            var faltam = resultado.filter(function (i) { return !idsRemoto.has(String(i.id)) && i._bk; });
            var precisaEnviar = faltam.length > 0 || Array.from(exclL).some(function (id) { return !exclR.has(id); });
            return Promise.all(faltam.map(function (i) {
                return A._i.obterBlobLocal(i._bk).then(function (b) { if (b) return enviarBlob(i._bk, b); });
            })).then(function () {
                if (precisaEnviar) agendar(k);
                return alterou;
            });
        });
    }

    function sincronizar() {
        if (!usuario) return Promise.resolve();
        definirEstado('sincronizando');
        return colecao().get().then(function (snap) {
            var remotos = new Map();
            snap.forEach(function (d) { var x = d.data(); if (x && x.chave) remotos.set(x.chave, x); });
            var mudou = false;
            var tarefas = [];

            remotos.forEach(function (r, k) {
                if (!chaveValida(k)) return;
                if (PADRAO_HIST.test(k)) {
                    tarefas.push(mesclarHistorico(k, r).then(function (a) { if (a) mudou = true; }));
                    return;
                }
                var tl = A._i.tempo(k) || 0;
                if ((r.t || 0) > tl) {
                    if (r.removido) { A._i.removerRemoto(k, r.t); mudou = true; }
                    else tarefas.push(valorRemoto(k, r).then(function (v) { A._i.gravarRemoto(k, v, r.t); mudou = true; }));
                } else if ((r.t || 0) < tl) {
                    agendar(k);
                }
            });

            // o que existe só aqui vai para a nuvem
            A._i.chaves().forEach(function (k) {
                if (!chaveValida(k) || remotos.has(k)) return;
                if (PADRAO_HIST.test(k)) tarefas.push(mesclarHistorico(k, { removido: true, excluidos: [] }));
                else agendar(k);
            });

            return Promise.all(tarefas).then(function () { return mudou; });
        }).then(function (mudou) {
            return descarregar().then(function () {
                if (mudou) {
                    var ja = false;
                    try { ja = !!sessionStorage.getItem(FLAG_RELOAD); } catch (_) {}
                    if (!A._i.interagiu() && !ja) {
                        try { sessionStorage.setItem(FLAG_RELOAD, '1'); } catch (_) {}
                        location.reload();
                    } else {
                        definirEstado('atualizar');
                    }
                } else {
                    try { sessionStorage.removeItem(FLAG_RELOAD); } catch (_) {}
                    if (estado !== 'erro') definirEstado('ok');
                }
            });
        }).catch(function (e) {
            console.warn('[Nuvem] falha na sincronização', e);
            if (e && e.code === 'permission-denied') { if (estado !== 'negado') acessoNegado(); return; }
            definirEstado(navigator.onLine ? 'erro' : 'offline');
        });
    }

    /* ------------------------------ Início ------------------------------ */
    function iniciar() {
        var pronto = window.firebase && window.firebase.apps
            ? Promise.resolve()
            : carregarJs(SDK + 'firebase-app-compat.js')
                .then(function () { return carregarJs(SDK + 'firebase-auth-compat.js'); })
                .then(function () { return carregarJs(SDK + 'firebase-firestore-compat.js'); })
                .then(function () { return carregarJs(SDK + 'firebase-storage-compat.js'); });

        return pronto.then(function () {
            if (!firebase.apps.length) firebase.initializeApp(cfg);
            auth = firebase.auth();
            db = firebase.firestore();
            st = firebase.storage();
            try {
                db.settings({ cacheSizeBytes: firebase.firestore.CACHE_SIZE_UNLIMITED, ignoreUndefinedProperties: true });
                db.enablePersistence({ synchronizeTabs: true }).catch(function () {});
            } catch (_) {}

            A.nuvem = { agendar: agendar, enviarBlob: enviarBlob, removerBlob: removerBlob, baixarBlob: baixarBlob, sincronizar: sincronizar };
            criarBadge();
            definirEstado('deslogado');

            auth.onAuthStateChanged(function (u) {
                usuario = u || null;
                if (usuario) {
                    resolverLogin();
                    sincronizar();
                } else {
                    definirEstado('deslogado');
                }
            });
            window.addEventListener('online', function () { if (usuario) { reenviarFalhos(); sincronizar(); } });
            window.addEventListener('offline', function () { if (usuario) definirEstado('offline'); });
        });
    }

    iniciar().catch(function (e) {
        console.warn('[Nuvem] indisponível (sem internet ou bloqueio). Seguindo só com o armazenamento local.', e);
    });
})();
