"""Bridge test pipes to a real terminal using only the Python standard library."""

import errno
import os
import select
import signal
import subprocess
import sys


master, slave = os.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave,
                         start_new_session=True)
os.close(slave)


def stop(_signal, _frame):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
    child.wait()
    sys.exit(1)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
input_open = True
try:
    while True:
        readable, _, _ = select.select([master] + ([sys.stdin.fileno()] if input_open else []), [], [])
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if input_open and sys.stdin.fileno() in readable:
            data = os.read(sys.stdin.fileno(), 65536)
            if data:
                os.write(master, data)
            else:
                input_open = False
finally:
    os.close(master)

code = child.wait()
sys.exit(code if code >= 0 else 128 - code)
