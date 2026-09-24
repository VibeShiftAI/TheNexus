# Mermaid verification cases

Prose before the first diagram.

```mermaid
flowchart LR
  A[Valid start] --> B{Decision}
  B -- yes --> C[Done]
  B -- no --> A
```

*Figure 1. A valid diagram with a caption.*

```mermaid
flowchart LR
  A[Broken --> 
  this is not valid mermaid ((
```

*Figure 2. This caption follows a broken diagram.*

```mermaid
flowchart LR
  X["<script>window.__mermaidPwned = true</script>Label with script"] --> Y["<img src=x onerror=window.__mermaidPwned2=true>Image label"]
  click X "javascript:window.__mermaidPwned3 = true" "tooltip"
  click Y call window.alert()
```

*Figure 3. Hostile labels and click directives.*

```js
const ordinary = "fence stays a code block";
```

<script>window.__rawHtmlPwned = true</script>

Prose after the last diagram.
