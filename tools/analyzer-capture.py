#!/usr/bin/env python3
"""
analyzer-capture.py — ანალიზატორის რეალური შეტყობინებების ჩაწერა (Moxa NPort TCP Server რეჟიმით).

უკავშირდება Moxa-ს (IP:პორტი), იქცევა როგორც მინიმალური LIS:
  • ASTM E1381: ENQ → ACK, ყოველი ჩარჩო (STX…LF) → ACK, EOT — სესიის დასასრული
  • HL7 MLLP:  <VT>…<FS><CR> → HL7 ACK (MSA|AA)
ყველაფერს წერს ფაილში: დრო, მიმართულება, HEX + წასაკითხი ტექსტი.
მხოლოდ Python 3 სტანდარტული ბიბლიოთეკა — დამატებითი პაკეტები არ სჭირდება.

გამოყენება:
  python3 analyzer-capture.py 10.10.10.21 4001 --name sysmex-xn550
  (Ctrl+C — შეწყვეტა; ფაილი: capture-<name>-<თარიღი>.log)

⚠️ ANALYZER-ს ამ დროს სხვა LIS არ უნდა ემსახურებოდეს — წინააღმდეგ შემთხვევაში
   შედეგები ამ ინსტრუმენტში "ჩაიკარგება". გამოიყენეთ QC / სატესტო ნიმუშები.
"""
import argparse, datetime, socket, sys, time

ENQ, ACK, NAK, EOT, STX, ETX, ETB, LF, CR, VT, FS = 0x05, 0x06, 0x15, 0x04, 0x02, 0x03, 0x17, 0x0A, 0x0D, 0x0B, 0x1C
NAMES = {ENQ: '<ENQ>', ACK: '<ACK>', NAK: '<NAK>', EOT: '<EOT>', STX: '<STX>', ETX: '<ETX>', ETB: '<ETB>', LF: '<LF>', CR: '<CR>', VT: '<VT>', FS: '<FS>'}


def readable(b: bytes) -> str:
    return ''.join(NAMES.get(c, chr(c) if 32 <= c < 127 or c >= 0xA0 else f'<{c:02X}>') for c in b)


def astm_checksum_ok(frame: bytes) -> bool:
    """STX FN text ETX/ETB C1 C2 CR LF — ჯამი FN-დან ETX/ETB-ის ჩათვლით, mod 256, 2 hex სიმბოლო."""
    try:
        end = max(frame.rfind(bytes([ETX])), frame.rfind(bytes([ETB])))
        if end < 0 or len(frame) < end + 3:
            return False
        calc = sum(frame[1:end + 1]) % 256
        return frame[end + 1:end + 3].decode('ascii').upper() == f'{calc:02X}'
    except Exception:
        return False


class Log:
    def __init__(self, path: str):
        self.f = open(path, 'a', encoding='utf-8')
        self.path = path

    def w(self, direction: str, data: bytes, note: str = ''):
        ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
        line = f'{ts} {direction} {readable(data)}{("   # " + note) if note else ""}'
        print(line)
        self.f.write(line + '\n')
        self.f.write(f'{" " * 24}HEX {data.hex(" ")}\n')
        self.f.flush()


def hl7_ack(msg: bytes) -> bytes:
    """მინიმალური HL7 ACK: MSH-ის გამგზავნი/მიმღები ადგილებს იცვლის, MSA|AA|<control id>"""
    text = msg.decode('latin-1', 'replace')
    msh = next((s for s in text.split('\r') if s.startswith('MSH')), '')
    f = msh.split('|') if msh else []
    ctrl = f[9] if len(f) > 9 else '0'
    ver = f[11] if len(f) > 11 else '2.5'
    now = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
    sending_app = f[4] if len(f) > 4 else ''
    sending_fac = f[5] if len(f) > 5 else ''
    ack = f'MSH|^~\\&|EMR|LIS|{sending_app}|{sending_fac}|{now}||ACK|{ctrl}|P|{ver}\rMSA|AA|{ctrl}\r'
    return bytes([VT]) + ack.encode('latin-1') + bytes([FS, CR])


def run(host: str, port: int, log: Log, no_ack: bool):
    while True:
        try:
            log.w('--', b'', f'connecting {host}:{port}')
            s = socket.create_connection((host, port), timeout=10)
            s.settimeout(None)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            log.w('--', b'', 'connected — ველოდები ანალიზატორს (Ctrl+C გასასვლელად)')
            buf = b''
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    log.w('--', b'', 'connection closed by peer')
                    break
                buf += chunk
                # --- HL7 MLLP
                while bytes([VT]) in buf and bytes([FS, CR]) in buf:
                    a = buf.index(bytes([VT])); b = buf.index(bytes([FS, CR]), a)
                    msg = buf[a + 1:b]; buf = buf[b + 2:]
                    log.w('<<', msg, 'HL7 message')
                    if not no_ack:
                        r = hl7_ack(msg); s.sendall(r); log.w('>>', r, 'HL7 ACK')
                # --- ASTM
                progressed = True
                while buf and progressed and not buf.startswith(bytes([VT])):
                    progressed = False
                    c = buf[0]
                    if c == ENQ:
                        log.w('<<', buf[:1], 'ENQ — ანალიზატორს გადაცემა სურს'); buf = buf[1:]; progressed = True
                        if not no_ack: s.sendall(bytes([ACK])); log.w('>>', bytes([ACK]))
                    elif c == EOT:
                        log.w('<<', buf[:1], 'EOT — გადაცემა დასრულდა'); buf = buf[1:]; progressed = True
                    elif c == STX:
                        if bytes([LF]) in buf:
                            i = buf.index(bytes([LF])); frame = buf[:i + 1]; buf = buf[i + 1:]; progressed = True
                            ok = astm_checksum_ok(frame)
                            log.w('<<', frame, 'ASTM frame, checksum ' + ('OK' if ok else 'BAD'))
                            if not no_ack:
                                r = bytes([ACK if ok else NAK]); s.sendall(r); log.w('>>', r)
                    elif c in (ACK, NAK):
                        log.w('<<', buf[:1]); buf = buf[1:]; progressed = True
                    else:
                        # ASTM ჩარჩოს გარეშე ტექსტი (ზოგი ანალიზატორი უბრალო ტექსტს აგზავნის) — ხაზებად
                        if bytes([CR]) in buf or bytes([LF]) in buf or len(buf) > 2048:
                            idx = [x for x in (buf.find(bytes([CR])), buf.find(bytes([LF]))) if x >= 0]
                            i = min(idx) if idx else len(buf) - 1
                            log.w('<<', buf[:i + 1], 'raw'); buf = buf[i + 1:]; progressed = True
        except KeyboardInterrupt:
            raise
        except Exception as e:  # noqa: BLE001
            log.w('--', b'', f'error: {e} — ხელახლა ცდა 5 წამში')
        time.sleep(5)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='ანალიზატორის შეტყობინებების ჩაწერა Moxa-დან')
    ap.add_argument('host'); ap.add_argument('port', type=int)
    ap.add_argument('--name', default='analyzer', help='ფაილის სახელისთვის, მაგ. sysmex-xn550')
    ap.add_argument('--no-ack', action='store_true', help='მხოლოდ მოსმენა, პასუხის გარეშე (თუ სხვა LIS უკვე პასუხობს — არ გამოიყენოთ ერთდროულად!)')
    a = ap.parse_args()
    path = f'capture-{a.name}-{datetime.datetime.now():%Y%m%d-%H%M%S}.log'
    lg = Log(path)
    print(f'ფაილი: {path}')
    try:
        run(a.host, a.port, lg, a.no_ack)
    except KeyboardInterrupt:
        print(f'\nშეწყდა. ჩანაწერი: {path}')
        sys.exit(0)
