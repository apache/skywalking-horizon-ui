{{ .LicenseContent }}

========================================================================
   Apache SkyWalking Horizon UI Subcomponents:

   The Apache SkyWalking Horizon UI binary distribution includes a number
   of subcomponents with separate copyright notices and license terms.
   Your use of the source code for these subcomponents is subject to the
   terms and conditions of the licenses listed below.

   Subcomponents under a license other than the standard permissive ones
   (MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD and Apache-2.0) have their
   full license text reproduced in the licenses/ directory of this
   distribution.

   By license family, the bundled third-party software is:
========================================================================
{{ range .Groups }}
--- {{ .LicenseID }} ---
{{ range .Deps }}
  * {{ .Name }}@{{ .Version }}
{{- end }}
{{ end }}
