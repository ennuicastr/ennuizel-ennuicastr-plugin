PREFIX=inst

all: ennuizel-ennuicastr.js

ennuizel-ennuicastr.js: ennuizel-ennuicastr.ts node_modules/.bin/tsc
	./node_modules/.bin/tsc -t es5 --lib es2015,dom $<

node_modules/.bin/tsc:
	npm install

install:
	mkdir -p $(PREFIX)
	install -m 0622 ennuizel-ennuicastr.js $(PREFIX)/ennuizel-ennuicastr.js

clean:
	rm -f ennuizel-ennuicastr.js

distclean: clean
	rm -rf node_modules
