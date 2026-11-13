# The stock OpenMRS 3 frontend, plus the CDS Hooks module in ./cds-hooks-app.
#
# The module needs no build: it is copied next to the other frontend modules and
# listed in the two files the app shell reads to find modules, the import map
# (where a module's script is) and the routes registry (its pages and extensions).
ARG O3_TAG=3.8.0
FROM openmrs/openmrs-reference-application-3-frontend:${O3_TAG}

COPY cds-hooks-app /usr/share/nginx/html/cds-hooks-app

# The script's URL carries a checksum, as browsers cache frontend scripts for a
# year. The .gz/.br copies of the two files are removed, as nginx would
# otherwise keep serving those instead of the changed files.
RUN cd /usr/share/nginx/html \
 && version=$(sha256sum cds-hooks-app/cds-hooks-app.js | cut -c1-12) \
 && perl -MJSON::PP -0777 -i -pe ' \
      my $j = decode_json($_); \
      $j->{imports}{"\@guideline-demo/esm-cds-hooks-app"} = "./cds-hooks-app/cds-hooks-app.js?v='"$version"'"; \
      $_ = encode_json($j)' importmap.json \
 && perl -MJSON::PP -0777 -i -pe ' \
      BEGIN { local $/; open my $f, "<", "cds-hooks-app/routes.json" or die $!; $routes = decode_json(<$f>) } \
      my $j = decode_json($_); \
      $j->{routes}{"\@guideline-demo/esm-cds-hooks-app"} = $routes; \
      $_ = encode_json($j)' routes.registry.json \
 && rm -f importmap.json.gz importmap.json.br routes.registry.json.gz routes.registry.json.br \
 && grep -q guideline-demo importmap.json && grep -q guideline-demo routes.registry.json
