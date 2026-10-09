# Certificats du broker (MQTTS)

Lus par `docker-compose.yml` : sans l'un d'eux, `docker compose up` s'arrête.

| Fichier | Rôle | Commité |
|---|---|---|
| `server.crt` | Certificat du broker, signé par « Sentinel-X CA » | oui |
| `server.key` | Clé privée du broker | **non** (`*.key` ignoré, GUIDELINES §10) : à copier à la main sur le serveur |
| `ca.crt` | Certificat de « Sentinel-X CA », vérifié par l'API, le faux boîtier et l'ESP | pas encore (public, peut l'être) : à copier à la main |

La clé de l'autorité (`ca.key`) ne vient jamais ici : elle reste chez la brique INFRA.

Noms couverts par `server.crt` : `localhost`, `mosquitto`, `host.docker.internal`,
`127.0.0.1`, `192.168.137.158`. Un client qui joint le broker par un autre nom ou
une autre IP échoue à la vérification : régénérer le certificat avec ce nom.

L'ESP ne lit que les entrées `DNS` : l'IP du serveur doit y figurer aussi en `DNS:`,
ce qui n'est pas le cas de ce `server.crt`. Commandes de génération :
[`firmware/README.md`](../../../firmware/README.md#chiffrement-mqtts).

```bash
openssl x509 -in server.crt -noout -subject -ext subjectAltName -enddate
openssl verify -CAfile ca.crt server.crt        # doit répondre OK
```

Côté ESP : `ca.crt` dans le firmware (BearSSL `X509List`), connexion sur le port
publié (`SX_MQTT_PORT`, 6083 par défaut) à l'IP du serveur.
