"""Servidor local do JARVIS Studio — Assistente de Mídia (porta 3336).

Servidor estático sem dependências (http.server padrão). Serve o SPA.
Uso:  python server.py   (depois abra http://localhost:3336)
"""
import os
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = '127.0.0.1'
PORT = 3336


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silencia logs por requisição
        pass


def main() -> None:
    os.chdir(Path(__file__).resolve().parent)
    server = ThreadingHTTPServer((HOST, PORT), QuietHandler)
    print('\n  🤖 JARVIS Studio — Assistente de Mídia')
    print(f'  🌐 http://localhost:{PORT}\n')
    webbrowser.open(f'http://localhost:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Servidor encerrado.')


if __name__ == '__main__':
    main()
