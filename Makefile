all: ennuizel-ennuicastr.js

ennuizel-ennuicastr.js: ennuizel-ennuicastr.ts node_modules/.bin/tsc
	./node_modules/.bin/tsc -t es5 --lib es2015,dom $<

node_modules/.bin/tsc:
	npm install

clean:
	rm -f ennuizel-ennuicastr.js

distclean: clean
	rm -rf node_modules
