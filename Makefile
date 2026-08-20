PYTHON ?= python3

.PHONY: help install test selftest demo web web-test clean

help:
	@echo "make install    install the runtime dependency"
	@echo "make test       run the test suite (no root required)"
	@echo "make selftest   check that a tunnel works on this machine"
	@echo "make demo       run a real client and server locally (needs root)"
	@echo "make web-test   check the node picker page (needs playwright)"
	@echo "make web        preview the node picker page at http://localhost:8000"

install:
	$(PYTHON) -m pip install -r requirements.txt

test:
	$(PYTHON) -m unittest discover -s tests -t . -v

selftest:
	$(PYTHON) -m pyvpn selftest

demo:
	sudo $(PYTHON) scripts/local_demo.py

web-test:
	node docs/logic.test.mjs
	$(PYTHON) docs/browser.test.py

web:
	cd docs && $(PYTHON) -m http.server 8000

clean:
	find . -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
	rm -rf build dist *.egg-info
