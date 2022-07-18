let blitzboard;
let markers = [];
let editor, configEditor;
$(() => {
  let defaultConfig =
    `
        {
          node: {
            caption: ['id'],
            defaultIcon: true,
          },
          edge: {
            caption: ['label'],
          },
          layout: 'default',
        
          /*
          layout: 'hierarchical',
          layoutSettings: {
            enabled:true,
            levelSeparation: 150,
            nodeSpacing: 100,
            treeSpacing: 200,
            blockShifting: true,
            edgeMinimization: true,
            parentCentralization: true,
            direction: 'UD',        // UD, DU, LR, RL
            sortMethod: 'hubsize',  // hubsize, directed
            shakeTowards: 'leaves'  // roots, leaves
          },
          layout: 'custom',
          layoutSettings: {
            x: 'x',
            y: 'y'
          },
          */
        }
                `;

  const q = document.querySelector.bind(document);
  const qa = document.querySelectorAll.bind(document);


  let container = document.getElementById('graph');
  let pgTimerId = null, configTimerId = null;
  let localMode = true;
  blitzboard = new Blitzboard(container);
  let byProgram = false;
  let prevInputWidth = null;
  let config, prevConfig;
  let autocompletion = true;
  let showConfig = false;
  let srcNode, lineEnd;
  let prevNetwork = null;
  let viewMode = loadConfig('viewMode');
  let savedGraphs = [];
  let pgToBeSorted;
  let sortModal = new bootstrap.Modal(document.getElementById('sort-modal'));
  let bufferedContent = ''; // A buffer to avoid calling editor.setValue() too often
  let candidatePropNames = new Set(), candidateLabels = new Set(), candidateIds = new Set();
  let dateTimeFormat = new Intl.DateTimeFormat('default', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  });

  String.prototype.quoteIfNeeded = function() {
    if(this.includes('"') || this.includes('#') || this.includes('\t') || this.includes(':') || this.includes(' ')) {
      return `"${this.replace(/\"/g, '""')}"`;
    }
    return this;
  }


  if(!localStorage.getItem('currentGraphName')) {
    localStorage.setItem('currentGraphName', newGraphName());
  }

  function scrollToLine(loc) {
    if(!loc)
      return;
    byProgram = true;
    editor.scrollIntoView({line: loc.start.line - 1, ch: loc.start.column - 1}, 200);
    editor.setSelection({line: loc.start.line - 1, ch: loc.start.column - 1}, {line: loc.end.line - 1, ch: loc.end.column - 1});
    editor.focus();
    byProgram = false;
  }

  blitzboard.onNodeAdded.push((nodes) => {
    byProgram = true;
    let content = bufferedContent || editor.getValue();
    for(let node of nodes) {
      content += `\n${node.id.quoteIfNeeded()}`;
      for(let label of node.labels)
        content += ` :${label.quoteIfNeeded()}`;
      for(let key in node.properties)
        for(let value of node.properties[key])
          content += ` ${key.quoteIfNeeded()}:${value.quoteIfNeeded()}`;
    }
    bufferedContent = content;
    byProgram = false;
  });


  blitzboard.onUpdated.push((nodes) => {
    if(bufferedContent) {
      byProgram = true;
      editor.setValue(bufferedContent);
      bufferedContent = null;
      byProgram = false;
    }
    updateAutoCompletion();
    localStorage.setItem('pg', editor.getValue());
  });

  blitzboard.beforeParse.push(() => {
    for(let marker of markers)
      marker.clear();
    markers = [];
  });

  blitzboard.onParseError.push((e) => {
    if (!e.hasOwnProperty('location'))
      throw(e);
    let loc = e.location;
    // Mark leading characters in the error line
    markers.push(editor.markText({line: loc.start.line - 1, ch: 0}, {line: loc.start.line - 1, ch: loc.start.column - 1}, {className: 'syntax-error-line', message: e.message}));
    markers.push(editor.markText({line: loc.start.line - 1, ch: loc.start.column - 1}, {line: loc.end.line - 1, ch: loc.end.column - 1}, {className: 'syntax-error', message: e.message}));
    // Mark following characters in the error line
    markers.push(editor.markText({line: loc.end.line - 1, ch: loc.end.column - 1}, {line: loc.end.line - 1, ch: 10000},
      {className: 'syntax-error-line', message: e.message}));
    toastr.error(e.message, 'PG SyntaxError', {preventDuplicates: true})
  });

  blitzboard.onEdgeAdded.push((edges) => {
    byProgram = true;
    let content = bufferedContent || editor.getValue();
    for(let edge of edges) {
      content += `\n${edge.from.quoteIfNeeded()} ${edge.direction} ${edge.to.quoteIfNeeded()}`;
      for(let label of edge.labels)
        content += ` :${label.quoteIfNeeded()}`;
      for(let key in edge.properties)
        for(let value of edge.properties[key])
          content += ` ${key.quoteIfNeeded()}:${value.quoteIfNeeded()}`;
    }
    bufferedContent = content;
    byProgram = false;
  });

  q('#url-input').addEventListener('change', () => {
    clearTimeout(pgTimerId);
    localMode = false;
    pgTimerId = setTimeout(retrieveGraph, 1000);
  });


  q('#share-btn').addEventListener('click', () => {
    let url = new URL(window.location);
    let params = new URLSearchParams();
    params.set('pg', editor.getValue());
    params.set('config', configEditor.getValue());
    params.set('viewMode', viewMode);
    params.set('name', localStorage.getItem('currentGraphName'));
    url.search = params;
    if(url.length > 7333) {
      alert("The content is too large for sharing via URI (Current: " + url.length + " / Max: 7333). Please export instead.");
    } else {
      if (!navigator.clipboard) {
        alert("Sharing is not allowed under non-secure HTTP. Please export your graph or use HTTPS.");
      } else {
        navigator.clipboard.writeText(url.toString()).then(function() {
          alert("Your graph is now on clipboard!");
        });
      }
    }
  });

  function onResize(event, ui) {
    const totalWidth = $("#main-area").width();
    let width = $("#input-area").width();
    if(width > totalWidth) {
      width = totalWidth;
      $('#input-area').css('width', width);
    }
    localStorage.setItem('inputAreaWidth', width);
    $('#graph-pane').css('width', (totalWidth - width));
    onConfigResize(null, null);
  }

  function configCollapsed() {
    return $('#config-area').css('height') == '0px';
  }

  function onConfigResize(event, ui) {
    const totalHeight = $("#input-area").height();
    let height = $("#pg-area").height();
    if(height > totalHeight) {
      height = totalHeight;
    }
    let left = $("#pg-area").width() - 50;
    let bottom = (totalHeight - height) + 10;
    $('#pg-area').css('height', height);
    $('#config-area').css('height', (totalHeight - height));
    $('#options-btn').css('bottom', bottom);
    $('#options-btn').css('left', left);
    if(configCollapsed()) {
      $('#reset-config-btn').hide();
    } else {
      $('#reset-config-btn').show();
      $('#reset-config-btn').css('left', left);
      $('#reset-config-btn').css('bottom', bottom - 70);
    }
  };


  function getMousePos(canvas, evt) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top
    };
  }


  function updateAutoCompletion() {
    candidateIds = new Set();
    candidatePropNames = new Set();
    candidateLabels = new Set();
    for(let node of blitzboard.graph.nodes) {
      candidateIds.add(node.id);
      for(let key in node.properties)
      {
        candidatePropNames.add(key);
      }
      for(let label of node.labels) {
        candidateLabels.add(':' + label);
      }
    }
    for(let edge of blitzboard.graph.edges) {
      for(let label of edge.labels) {
        candidateLabels.add(':' + label);
      }
      for(let key in edge.properties)
      {
        candidatePropNames.add(key);
      }
    }
  }

  function updateGraph(input, newConfig = null) {
    try {
      toastr.clear();
      if(newConfig) {
        blitzboard.setGraph(input, false);
        blitzboard.setConfig(newConfig);
      } else {
        blitzboard.setGraph(input);
      }
      if(blitzboard.warnings.length > 0) {
        for(let marker of markers)
          marker.clear();
        markers = [];
        for(let warning of blitzboard.warnings) {
          markers.push(editor.markText({line: warning.location.start.line - 1,
              ch: warning.location.start.column - 1}, {line: warning.location.end.line - 1, ch: warning.location.end.column - 1 },
            {className: 'syntax-warning-line', message: warning.message}));
        }
        toastr.warning(blitzboard.warnings.map(w => w.message).join(', '), {preventDuplicates: true})
      }
    } catch(e) {
      console.log(e);
      if(e instanceof Blitzboard.DuplicateNodeError) {
        for(let marker of markers)
          marker.clear();
        markers = [];
        for(let node of e.nodes) {
          markers.push(editor.markText({line: node.location.start.line - 1,
              ch: node.location.start.column - 1}, {line: node.location.end.line - 1, ch: node.location.end.column - 1 },
            {className: 'syntax-error-line', message: e.message}));
        }
        toastr.error(e.message, {preventDuplicates: true})
      } else {
        toastr.error(e.toString(), 'Error occured while rendering', {preventDuplicates: true})
      }
      return null;
    }
    if(blitzboard.network !== prevNetwork) {
      blitzboard.network.on("click", (e) => {
        if(srcNode) {
          if(e.nodes.length > 0) {
            let node = blitzboard.nodeMap[e.nodes[0]];
            if(srcNode !== node.id) {
              let oldPg = editor.getValue();
              let lineNum = numberOfLines(oldPg) + 1;
              editor.setValue(oldPg + `\n${srcNode.quoteIfNeeded()} -> ${node.id.quoteIfNeeded()}`);
              updateGraph(editor.getValue());
              scrollToLine({start: { line: lineNum, column: 1 }, end  : {line: lineNum + 1, column: 1}} );
            }
          }
          srcNode = null;
          lineEnd = null;
        }
        else if(e.nodes.length > 0) {
          let node = blitzboard.nodeMap[e.nodes[0]];
          scrollToLine(node.location);
        } else if(e.edges.length > 0) {
          let edge = blitzboard.edgeMap[e.edges[0]];
          scrollToLine(edge.location);
        }
      });
      blitzboard.network.on("doubleClick", (e) => {
        if(!blitzboard.config?.node?.onDoubleClick) {
          if(e.nodes.length > 0) {
            const node = e.nodes[0];
            srcNode = node;
          } else if (blitzboard.map) {
            let xKey =  blitzboard.config.layoutSettings.x;
            let yKey =  blitzboard.config.layoutSettings.y;
            let oldPg = editor.getValue();
            let lineNum = numberOfLines(oldPg) + 1;
            let latLng = blitzboard.map.containerPointToLatLng([e.pointer.DOM.x, e.pointer.DOM.y]);
            editor.setValue(oldPg + `\n${newNodeName()} ${xKey}:${latLng.lng} ${yKey}:${latLng.lat}`);
            updateGraph(editor.getValue());
            scrollToLine({start: { line: lineNum, ch: 0 }, end: {line: lineNum, ch: 0}} );
          }
        }
      });
      let canvas = q(".vis-network canvas");
      canvas.addEventListener('mousemove', event =>
      {
        if(srcNode) {
          lineEnd = blitzboard.network.DOMtoCanvas(getMousePos(canvas, event));
          blitzboard.network.redraw();
        }
      });

      blitzboard.network.on("afterDrawing", (ctx) => {
        if(srcNode && lineEnd) {
          ctx.beginPath();
          let lineStart = blitzboard.network.getPosition(srcNode);
          ctx.moveTo(lineStart.x, lineStart.y);
          ctx.lineTo(lineEnd.x, lineEnd.y);
          ctx.stroke();
        }
      });
      prevNetwork = blitzboard.network;
    }
    if(blitzboard.graph) {
      updateAutoCompletion();
    }
  }

  window.onresize = onResize;
  $('#input-area').resizable({handles: "e,s", grid: [1, 10000]}).bind( "resize", onResize).bind("create", onResize);
  $('#pg-area').resizable({handles: "s", grid: [10000, 1]}).bind("resize", onConfigResize);

  onConfigResize(null, null);

  function showOrHideConfig() {
    if (q('#options-show-config-input').checked) {
      $('#pg-area').css('height', '50%');
      $('#config-area').css('height', '50%');
    } else {
      $('#pg-area').css('height', '100%');
      $('#config-area').css('height', '0%');
    }
    onConfigResize(null, null);
  }

  $('.column-mode-btn').change(() => {
    if(!$('#input-area').resizable( "option", "disabled"))
      prevInputWidth = $('#input-area').css('width');
    if(q('#input-only-btn').checked) {
      $('#input-area').resizable('disable');
      $('#input-area').css('width', '100%');
      $('#graph-pane').css('width', '0px');
      viewMode = 'input-only';
    } else if(q('#double-column-btn').checked) {
      const totalWidth = $("#main-area").width();
      $('#input-area').resizable('enable');
      if(!prevInputWidth)
        prevInputWidth = totalWidth / 2;
      $('#input-area').css('width', prevInputWidth);
      $('#graph-pane').css('width', totalWidth - prevInputWidth);
      viewMode = 'double-column';
    } else if(q('#view-only-btn').checked) {
      $('#input-area').resizable('disable');
      $('#input-area').css('width', '0px');
      $('#graph-pane').css('width', '100%');
      viewMode = 'view-only';
    }
    localStorage.setItem('viewMode', viewMode);
    onResize(null, null);
  });


  q('#embed-btn').addEventListener('click', () => {
    content = `
                  window.addEventListener("load",function() {
                  let blitzboard; 
                  let container = document.getElementById('blitzboard');
                  blitzboard = new Blitzboard(container);
                  let config = ${configEditor.getValue()}
                  let graph = ${JSON.stringify(blitzboard.graph)};
                  blitzboard.setGraph(graph, false);
                  blitzboard.setConfig(config);
                  });
                  `;
    let currentGraphName = localStorage.getItem('currentGraphName');
    let name = (currentGraphName.startsWith('Untitled') ? 'graph' : currentGraphName) + '_' + currentTimeString();
    saveAs(new Blob([content], { type: 'text/plain' }), name + '.js');
    $('#export-btn').dropdown('toggle');
  });

  function newGraphName(baseName = 'Untitled') {
    // Check whether the name is suffixed by number like example-1
    let suffixMatched = baseName.match(/-(\d+$)/);
    let i = 0;
    if(suffixMatched) {
      let suffix = suffixMatched[0];
      baseName = baseName.substring(0, baseName.length - suffix.length);
      i = parseInt(suffixMatched[1]);
    }
    let name = baseName;
    while(localStorage.getItem('saved-graph-' + name)) {
      name =  baseName + '-' + (++i);
    }
    return name;
  }


  function newNodeName(baseName = 'New') {
    let name = baseName;
    let i = 0;
    while(blitzboard.nodeDataSet.get(name)) {
      name =  baseName + '-' + (++i);
    }
    return name;
  }

  function showGraphName() {
    $('#history-dropdown')[0].innerText = localStorage.getItem('currentGraphName');
  }

  function loadSavedGraphs() {
    savedGraphs = [];
    for (let i = 0; i < localStorage.length; i++){
      if ( localStorage.key(i).indexOf('saved-graph-') != -1 ) {
        try {
          savedGraphs.push(JSON.parse(localStorage.getItem(localStorage.key(i))));
        } catch(e) {
          localStorage.removeItem(localStorage.key(i));
        }
      }
    }

    let menu = q('#history-menu');
    // clear menu
    while (menu.firstChild) {
      menu.removeChild(menu.firstChild);
    }
    savedGraphs = savedGraphs.sort((a, b) => b.date - a.date);
    for(let graph of savedGraphs) {
      let node = document.createElement('a');
      node.className = 'dropdown-item history-item mr-3';
      if(graph.name === localStorage.getItem('currentGraphName'))
        node.className += ' active text-white';
      node.style = 'position:relative';
      node.appendChild(document.createTextNode(graph.name));
      node.appendChild(document.createElement("br"));
      node.appendChild(document.createTextNode(dateTimeFormat.format(new Date(graph.date))));
      let deleteButton = document.createElement('div');
      deleteButton.className = 'delete-history-btn btn btn-danger p-0';
      deleteButton.style = 'position:absolute; top: 5px; right: 5px; width: 25px; height: 25px';
      let span = document.createElement('span');
      span.className = 'ion-android-close';
      deleteButton.appendChild(span);
      node.appendChild(deleteButton);
      let editButton = document.createElement('div');
      editButton.className = 'edit-history-btn btn btn-secondary p-0';
      editButton.setAttribute('title', 'Edit name')
      editButton.style = 'position:absolute; top: 5px; right: 35px; width: 25px; height: 25px';
      span = document.createElement('span');
      span.className = 'ion-android-create';
      editButton.appendChild(span);

      node.appendChild(editButton);
      menu.appendChild(node);
    }
  }


  $(document).on('click', '.edit-history-btn', (e) => {
    let item = $(e.target).closest('.history-item')[0];
    let i = $('.history-item').index(item);
    let graph = savedGraphs[i];
    let newName = prompt('What is the new name of the graph?', graph.name);
    if(newName) {
      localStorage.removeItem('saved-graph-' + graph.name);
      if(localStorage.getItem('currentGraphName', graph.name)) {
        localStorage.setItem('currentGraphName', newName);
        showGraphName();
      }
      graph.name = newName;
      localStorage.setItem('saved-graph-' + graph.name, JSON.stringify(graph));
      loadSavedGraphs();
    }
    e.stopPropagation();
  });

  $(document).on('click', '.delete-history-btn', (e) => {
    let item = $(e.target).closest('.history-item')[0];
    let i = $('.history-item').index(item);
    let name = savedGraphs[i].name;
    if(confirm(`Really delete ${name}?`)) {
      localStorage.removeItem('saved-graph-' + name);
      savedGraphs.splice(i, 1);
      if(name == localStorage.getItem('currentGraphName')) {
        loadGraph(savedGraphs[i > 0 ? i - 1 : i]);
      }
      item.remove();
    }
    e.stopPropagation();
  });

  function loadGraph(graph) {
    byProgram = true;
    editor.setValue(graph.pg);
    configEditor.setValue(graph.config);
    editor.getDoc().clearHistory();
    configEditor.getDoc().clearHistory();
    localStorage.setItem('pg', editor.getValue());
    localStorage.setItem('currentGraphName', graph.name);
    $('.dropdown-item.history-item').removeClass('active');
    $('.dropdown-item.history-item').removeClass('text-white');
    let i = savedGraphs.indexOf(graph);
    $(`.dropdown-item.history-item:eq(${i})`).addClass('active');
    $(`.dropdown-item.history-item:eq(${i})`).addClass('text-white');
    reloadConfig();
    showGraphName();
    byProgram = false;
  }

  $(document).on('click', '.history-item', (e) => {
    let i = $('.history-item').index(e.target);
    let graph = savedGraphs[i];
    loadGraph(graph);
  });

  function saveCurrentGraph() {
    let name = localStorage.getItem('currentGraphName');
    if(!name) {
      name = newGraphName();
    }
    let i = -1;
    let graph = {
      pg: editor.getValue(),
      config: configEditor.getValue(),
      name: name,
      date: Date.now()
    };
    while(i < savedGraphs.length - 1 && savedGraphs[++i].name !== name);
    if(i < savedGraphs.length) {
      savedGraphs[i] = graph;
    }
    localStorage.setItem('saved-graph-' + name, JSON.stringify(graph));
  }

  q('#new-btn').addEventListener('click', () => {
    let name = newGraphName();
    byProgram = true;
    editor.setValue('');
    configEditor.setValue(defaultConfig);
    localStorage.setItem('currentGraphName', name);
    saveCurrentGraph();
    loadSavedGraphs();
    showGraphName();
    updateGraph('', defaultConfig);
    loadGraph({name:name, pg: '', config: defaultConfig});
    byProgram = false;
  });


  q('#clone-btn').addEventListener('click', () => {
    let name = newGraphName(localStorage.getItem('currentGraphName'));
    localStorage.setItem('currentGraphName', name);
    saveCurrentGraph();
    loadSavedGraphs();
    showGraphName();
    blitzboard.update(false);
    toastr.success(`Your graph is cloned as <em>${name}</em> !`, '', {preventDuplicates: true,  timeOut: 3000});
  });


  q('#reset-config-btn').addEventListener('click', () => {
    if(confirm("Really reset config?"))
      configEditor.setValue(defaultConfig);
  });

  q('#zoom-fit-btn').addEventListener('click', () => {
    if(blitzboard.network)
      blitzboard.network.fit();
  });

  q('#export-zip-btn').addEventListener('click', () => {
    var zip = new JSZip();
    let currentGraphName = localStorage.getItem('currentGraphName');
    let name = (currentGraphName.startsWith('Untitled') ? 'graph' : currentGraphName) + '_' + currentTimeString();
    zip.file("graph.pg", editor.getValue());
    zip.file("config.js", configEditor.getValue());
    zip.generateAsync({type:"blob"}).then(function (blob) {
      saveAs(blob, name + ".zip");
    });
    $('#export-btn').dropdown('toggle');
  });


  q('#import-btn').addEventListener('click', () => {
    q('#import-btn-input').value = '';
  });

  q('#import-btn').addEventListener('change', (evt) => {
    function handleFile(f) {
      let nameWithoutExtension = f.name.includes('.') ? f.name.split('.').slice(0, -1).join('.') : f.name;
      // Remove datetime part like '****_20200101123045
      nameWithoutExtension = nameWithoutExtension.replace(/_\d{8,15}$/, '');
      JSZip.loadAsync(f).then(function(zip) {
        if (!zip.file("graph.pg") || !zip.file("config.js")) {
          alert("Invalid zip file");
        } else {
          zip.file("graph.pg").async("string").then(function success(content) {
            let graph = content;
            zip.file("config.js").async("string").then(function success(content) {
              let config = content;
              // The same process as #new-btn is clicked
              let name = newGraphName(nameWithoutExtension);
              byProgram = true;
              editor.setValue(graph);
              configEditor.setValue(config);
              localStorage.setItem('pg', graph);
              localStorage.setItem('currentGraphName', name);
              saveCurrentGraph();
              loadSavedGraphs();
              editor.getDoc().clearHistory();
              configEditor.getDoc().clearHistory();
              showGraphName();
              byProgram = false;
            });
          });
        }
      }, function (e) {
        alert("Error reading " + f.name + ": " + e.message);
      });
    }

    var files = evt.target.files; // A single file is accepted so far
    for (var i = 0; i < files.length; i++) {
      handleFile(files[i]);
    }
  });

  q('#export-cypher-btn').addEventListener('click', () => {

    let pg = pgParser.parse(editor.getValue());
    let output = "";
    pg.nodes.forEach(node => {
      let node_label = (node.labels[0] === undefined) ? "UNDEFINED" : node.labels[0]
      let query = "";
      query = query + "CREATE (v:" + node_label + " {"; // Restriction: single vertex label
      query = query + "id: '" + node.id + "'"; // ID is stored as a string property
      for (let entry of Object.entries(node.properties)) {
        query = query + ", " + entry[0] + ": '" + entry[1] + "'"; // values are always stored as sting
      }
      query = query + "});";
      output = output + query + '\n';
    });
    pg.edges.forEach(edge => {
      let edge_label = (edge.labels[0] === undefined) ? "UNDEFINED" : edge.labels[0]
      let query = "";
      query = query + "MATCH (src {id: '" + edge.from + "'}) MATCH (dst {id: '" + edge.to + "'}) CREATE (src)-[e:";
      query = query + edge_label;
      query = query + " {";
      for (let entry of Object.entries(edge.properties)) {
        query = query + ", " + entry[0] + ": '" + entry[1] + "'"; // values are always stored as sting
      }
      query = query + "}]->(dst);";
      output = output + query + '\n';
    });
    saveAs(new Blob([output], { type: 'text/plain' }), 'graph_' + currentTimeString() + '.cypher');
    $('#export-btn').dropdown('toggle');
  });

  q('#export-pgql-btn').addEventListener('click', () => {
    let pg = pgParser.parse(editor.getValue());
    let graphName = localStorage.getItem('currentGraphName');
    let graphNamePGQL = graphName.replace('\'', '').replace(' ', '_').replace('-', '_').toLowerCase(); // must be simple SQL name
    let output = "";
    output = output + "CREATE PROPERTY GRAPH " + graphNamePGQL + ";\n";
    pg.nodes.forEach(node => {
      let node_label = (node.labels[0] === undefined) ? "UNDEFINED" : node.labels[0]
      let query = "";
      query = query + "INSERT INTO " + graphNamePGQL + " ";
      query = query + "VERTEX v LABELS (\"" + node_label.toUpperCase() + "\") "; // Restriction: single vertex label
      query = query + "PROPERTIES (";
      query = query + "v.id = '" + node.id + "'"; // ID is stored as a string property
      let json = "{\"ID\":[\"" + node.id + "\"]";
      for (let entry of Object.entries(node.properties)) {
        json = json + ", \"" + entry[0].toUpperCase() + "\":[\"" + entry[1] + "\"]"; // values are always stored as sting
      }
      json = json + "}";
      query = query + ", v.json = '" + json + "'";
      query = query + ");";
      output = output + query + '\n';
    });
    pg.edges.forEach(edge => {
      let edge_label = (edge.labels[0] === undefined) ? "UNDEFINED" : edge.labels[0]
      let query = "";
      query = query + "INSERT INTO " + graphNamePGQL + " ";
      query = query + "EDGE e BETWEEN src AND dst LABELS (\"" + edge_label.toUpperCase() + "\") "; // Restriction: single vertex label
      query = query + "PROPERTIES (";
      query = query + "e.direction = '" + edge.direction + "'";
      let json = "{\"FROM\":[\"" + edge.from + "\"], \"TO\":[\"" + edge.to + "\"]";
      for (let entry of Object.entries(edge.properties)) {
        json = json + ", \"" + entry[0].toUpperCase() + "\":[\"" + entry[1] + "\"]"; // values are always stored as sting
      }
      json = json + "}";
      query = query + ", e.json = '" + json + "'";
      query = query + ") ";
      query = query + "FROM MATCH ( (src), (dst) ) ON " + graphNamePGQL + " ";
      query = query + "WHERE src.id = '" + edge.from + "' AND dst.id = '" + edge.to + "';";
      output = output + query + '\n';
    });
    saveAs(new Blob([output], { type: 'text/plain' }), 'graph_' + currentTimeString() + '.pgql');
    $('#export-btn').dropdown('toggle');
  });

  q('#export-sql-btn').addEventListener('click', () => {
    let pg = pgParser.parse(editor.getValue());
    let graphName = localStorage.getItem('currentGraphName');
    let graphNameSQL = graphName.replace('\'', '').replace(' ', '_').replace('-', '_').toLowerCase(); // must be simple SQL name
    let output = "";
    let create_table_node = `
                    CREATE TABLE ${graphNameSQL}_node (
                      id VARCHAR2(255)
                    , label VARCHAR2(255)
                    , props VARCHAR2(4000)
                    , CONSTRAINT node_pk PRIMARY KEY (id)
                    , CONSTRAINT node_check CHECK (props IS JSON)
                    );
                  `;
    let create_table_edge = `
                    CREATE TABLE ${graphNameSQL}_edge (
                      id VARCHAR2(255)
                    , src VARCHAR2(255)
                    , dst VARCHAR2(255)
                    , label VARCHAR2(255)
                    , props VARCHAR2(4000)
                    , CONSTRAINT edge_pk PRIMARY KEY (id)
                    , CONSTRAINT edge_fk_src FOREIGN KEY (src) REFERENCES node(id)
                    , CONSTRAINT edge_fk_dst FOREIGN KEY (dst) REFERENCES node(id)
                    , CONSTRAINT edge_check CHECK (props IS JSON)
                    );
                  `;
    output = output + create_table_node + create_table_edge + "\n";
    pg.nodes.forEach(node => {
      let node_label = (node.labels[0] === undefined) ? "UNDEFINED" : node.labels[0]
      let json = "{\"ID\":[\"" + node.id + "\"]";
      for (let entry of Object.entries(node.properties)) {
        json = json + ", \"" + entry[0].toUpperCase() + "\":[\"" + entry[1] + "\"]"; // values are always stored as sting
      }
      json = json + "}";
      let query = `INSERT INTO ${graphNameSQL}_node VALUES ('${node.id}', '${node_label.toUpperCase()}', '${json}');`;
      output = output + query + '\n';
    });
    function generateUuid() {
      let chars = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".split("");
      for (let i = 0, len = chars.length; i < len; i++) {
        switch (chars[i]) {
          case "x":
            chars[i] = Math.floor(Math.random() * 16).toString(16);
            break;
          case "y":
            chars[i] = (Math.floor(Math.random() * 4) + 8).toString(16);
            break;
        }
      }
      return chars.join("");
    }
    pg.edges.forEach(edge => {
      let edge_label = (edge.labels[0] === undefined) ? "UNDEFINED" : edge.labels[0]
      let json = "{\"FROM\":[\"" + edge.from + "\"], \"TO\":[\"" + edge.to + "\"]";
      for (let entry of Object.entries(edge.properties)) {
        json = json + ", \"" + entry[0].toUpperCase() + "\":[\"" + entry[1] + "\"]"; // values are always stored as sting
      }
      json = json + "}";
      let query = `INSERT INTO ${graphNameSQL}_edge VALUES ('${generateUuid()}', '${edge.from}', '${edge.to}', '${edge_label.toUpperCase()}', '${json}');`;
      output = output + query + '\n';
    });
    saveAs(new Blob([output], { type: 'text/plain' }), 'graph_' + currentTimeString() + '.sql');
    $('#export-btn').dropdown('toggle');
  });

  q('#export-png-btn').addEventListener('click', () => {
    let url = blitzboard.network.canvas.getContext().canvas.toDataURL("image/png");
    let a = document.createElement('a');
    a.href = url;
    a.download = 'graph_' + currentTimeString() + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    $('#export-btn').dropdown('toggle');
  });

  editor = CodeMirror.fromTextArea(q('#graph-input'), {
    lineNumbers: true,
    viewportMargin: Infinity,
    theme: "monokai",
    lineWrapping: true,
    mode: "pgMode",
    extraKeys: {
      Tab: 'autocomplete'
    },
    hintOptions: {
      completeSingle: false
    }
  });
  editor.setSize('100%', '100%');

  toastr.options.timeOut = 0; // Set toastr persistent until remove() is called

  let oldHint = CodeMirror.hint.anyword;

  CodeMirror.hint.pgMode = function (editor) {
    let word =  /[\w$:]+/;
    let range = 200;
    let cur = editor.getCursor(), curLine = editor.getLine(cur.line);
    let end = cur.ch, start = end;
    while (start && word.test(curLine.charAt(start - 1))) --start;
    let curWord = start != end && curLine.slice(start, end);

    let list = [];

    for (let id of candidateIds) {
      if (id.includes(curWord) && id !== curWord)
        list.push(id);
    }

    for (let prop of candidatePropNames) {
      if (prop.includes(curWord) && prop !== curWord)
        list.push(prop);
    }

    for (let label of candidateLabels) {
      if (label.includes(curWord) && label !== curWord)
        list.push(label);
    }

    return {list: list, from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, end)};
  };

  configEditor = CodeMirror.fromTextArea(q('#config-input'), {
    viewportMargin: Infinity,
    theme: "monokai",
    mode: { name: 'javascript', json: true },
    lineWrapping: true,
    extraKeys: {
      Tab: function(cm) {
        var spaces = Array(cm.getOption("indentUnit") + 1).join(" ");
        cm.replaceSelection(spaces);
      },
      "Shift-Tab": "indentLess"
    },
    hintOptions: {
      completeSingle: false,
    },
  });

  configEditor.setSize('100%', '100%');

  editor.on("inputRead", (instance) => {
    if(autocompletion)
      editor.execCommand('autocomplete', { completeSingle: false });
  });

  function loadSample(sampleName, callback) {
    let graph, config;
    let graphPromise = new Promise((resolve, reject) => {
      $.get(`https://raw.githubusercontent.com/blitzboard/samples/main/${sampleName}/graph.pg`, (res) => {
        graph = res;
        resolve();
      });
    });
    let configPromise = new Promise((resolve, reject) => {
      $.get(`https://raw.githubusercontent.com/blitzboard/samples/main/${sampleName}/config.js`, (res) => {
        config = res;
        resolve();
      });
    });
    Promise.all([graphPromise, configPromise]).then(() => {
      callback(graph, config);
    });
  }


  function reflectEditorChange() {
    localStorage.setItem('pg', editor.getValue());
    saveCurrentGraph();
    blitzboard.hideLoader();

    updateGraph(editor.getValue());
    clearTimeout(pgTimerId);
    pgTimerId = null;
  }

  function onEditorChanged(delta){
    if(!byProgram) {
      if(!pgTimerId)
        blitzboard.showLoader("");
      clearTimeout(pgTimerId);
      localMode = true;
      pgTimerId = setTimeout(() => {
        reflectEditorChange();
      }, 1000);
    }
  }

  editor.on('keydown', (cm, e) => {
    if(e.ctrlKey && e.keyCode === 13) {
      // ctrl + enter
      reflectEditorChange();
    }
    // invoke only if timer is working
    else if(pgTimerId) onEditorChanged();
  });
  editor.on('change', onEditorChanged);
  editor.on('inputRead', onEditorChanged);

  editor.on('cursorActivity', (doc) => {
    if(!byProgram) {
      const node = blitzboard.nodeLineMap[doc.getCursor().line + 1];
      const edge = blitzboard.edgeLineMap[doc.getCursor().line + 1];

      if(node) {
        blitzboard.scrollNodeIntoView(node)
      } else if(edge){
        blitzboard.scrollEdgeIntoView(edge)
      }
    }
  });

  const urlParams = new URLSearchParams(window.location.search);
  let sampleName = urlParams.get('sample');
  if(sampleName) {
    loadSample(sampleName, (graph, config) => {
      localStorage.setItem('pg', graph);
      localStorage.setItem('config', config);
      localStorage.setItem('currentGraphName', newGraphName(sampleName));
      window.location.href = window.location.href.split('?')[0];
    });
  } else {
    let pgInParam = urlParams.get('pg'), nodePropInParam = urlParams.get('displayedNodeProps'),
      edgePropInParam = urlParams.get('displayedEdgeProps');
    let configInParam = urlParams.get('config');
    let graphNameInParam = urlParams.get('name');
    let viewModeInParam = urlParams.get('viewMode');
    if(pgInParam || nodePropInParam || edgePropInParam || configInParam || viewModeInParam) {
      if(pgInParam) {
        localStorage.setItem('pg', pgInParam);
        if(graphNameInParam) {
          localStorage.setItem('currentGraphName', graphNameInParam);
        } else {
          localStorage.setItem('currentGraphName', newGraphName());
        }
      }
      if(configInParam)
        localStorage.setItem('config', configInParam);
      if(viewModeInParam)
        localStorage.setItem('viewMode', viewModeInParam);
      window.location.href = window.location.href.split('?')[0]; // Jump to URL without query parameter
    }

    let initialPg = loadConfig('pg');

    let configText = loadConfig('config');

    if (!configText) {
      configText = defaultConfig;
    }
    if(!config) {
      config = tryJsonParse(configText);
    }

    if(config?.x2?.init) {
      editor.setValue('');
      let strParams = '?';
      config.x2.init.parameters.forEach(parameter => {
        strParams = strParams + parameter.key + '=' + parameter.value + '&';
      });
      const strUrl = config.x2.url + config.x2.init.endpoint + strParams;
      axios.get(strUrl).then((response) => {
        editor.setValue(json2pg.translate(JSON.stringify(response.data.pg)));
        editor.getDoc().clearHistory();
      });
    }
    // Otherwise, load PG data from browser local storage
    else if(initialPg) {
      byProgram = true;
      editor.setValue(initialPg);
      byProgram = false;
      editor.getDoc().clearHistory();
    }
    configEditor.setValue(configText);
    configEditor.getDoc().clearHistory();

    function tryJsonParse(json) {
      try {
        return looseJsonParse(json);
      } catch(e) {
        console.log(e);
        toastr.error(e.toString(), 'JSON SyntaxError', {preventDuplicates: true});
        return null;
      }
    }


    function reloadConfig() {
      localStorage.setItem('config', configEditor.getValue());
      config = tryJsonParse(configEditor.getValue());
      saveCurrentGraph();
      if(config)
        updateGraph(editor.getValue(), config);
      clearTimeout(configTimerId);
      blitzboard.hideLoader();
      configTimerId = null;
    }

    function onConfigChanged(delta) {
      if(!configTimerId)
        blitzboard.showLoader('');
      clearTimeout(configTimerId);
      configTimerId = setTimeout(reloadConfig, 2000);
    }

    configEditor.on('keydown', (cm, e) => {
      if(e.ctrlKey && e.keyCode === 13) {
        // ctrl + enter
        reloadConfig();
      }
      // invoke only if timer is working
      else if(configTimerId) onConfigChanged();
    });

    configEditor.on('change', onConfigChanged);
    configEditor.on('inputRead', onConfigChanged);

    if(editor.getValue() && config) {
      byProgram = true;
      updateGraph(editor.getValue(), config);
      byProgram = false;
    }

    let autocompletionConfig = localStorage.getItem('autocompletion');
    if(autocompletionConfig !== null) {
      autocompletion = autocompletionConfig === 'true';
      $('#options-auto-complete-input').prop('checked', autocompletion);
    }


    $('#options-auto-complete').click((e) => {
      autocompletion = !$('#options-auto-complete-input').prop('checked');
      $('#options-auto-complete-input').prop('checked', autocompletion);
      e.preventDefault();
      localStorage.setItem('autocompletion', autocompletion);
    });

    let optionsShowConfig = localStorage.getItem('optionsShowConfig');
    if(optionsShowConfig !== null) {
      showConfig = optionsShowConfig === 'true';
      $('#options-show-config-input').prop('checked', showConfig);
      showOrHideConfig();
    }

    $('#options-show-config').click((e) => {
      showConfig = !$('#options-show-config-input').prop('checked');
      $('#options-show-config-input').prop('checked', showConfig);
      e.preventDefault();
      localStorage.setItem('optionsShowConfig', showConfig);
      showOrHideConfig();
    });


    $('#options-sort').click((e) => {
      if(/^\s*#/m.test(editor.getValue())) {
        q('#comment-warning-line').classList.remove('d-none');
      } else {
        q('#comment-warning-line').classList.add('d-none');
      }
      pgToBeSorted = blitzboard.tryPgParse(editor.getValue());
      if(!pgToBeSorted) {
        alert('Please write a valid graph before sort.');
      }
      q('#sort-node-lines-select').innerHTML = "<option value=''>None</option>" +
        "<option value=':id'>id</option>" +
        "<option value=':label'>label</option>" +
        Object.entries(blitzboard.graph.nodeProperties).sort((a, b) => b[1] - a[1]).map((p) => `<option>${p[0]}</option>`);
      q('#sort-edge-lines-select').innerHTML = "<option value=''>None</option>" +
        "<option value=':from-to'>from&to</option>" +
        "<option value=':label'>label</option>" +
        Object.entries(blitzboard.graph.edgeProperties).sort((a, b) => b[1] - a[1]).map((p) => `<option>${p[0]}</option>`);
      sortModal.show();
    });



    $('#sort-btn').click((e) => {
      let newPG = '';
      let oldPG = editor.getValue();
      let oldPGlines = oldPG.split("\n");
      let { nodes, edges } = pgToBeSorted;
      let nodeKey = q('#sort-node-lines-select').value;
      let edgeKey = q('#sort-edge-lines-select').value;
      let order = parseInt(document.querySelector('input[name="sort-order"]:checked').value);

      /// Order should be -1 (descending) or 1 (ascending)
      function generateComparator(mapFunction) {
        return (a, b) => {
          let aVal = mapFunction(a);
          let bVal = mapFunction(b);
          return order * (bVal > aVal ? -1 : (aVal == bVal ? 0 : 1));
        }
      }
      if(nodeKey) {
        switch(nodeKey) {
          case ':id':
            nodes.sort(generateComparator((n) => n.id));
            break;
          case ':label':
            nodes.sort(generateComparator((n) => n.labels?.[0]));
            break;
          default:
            nodes.sort(generateComparator((n) => n.properties[nodeKey]?.[0]));
            break;
        }
      }
      if(edgeKey) {
        switch(edgeKey) {
          case ':from-to':
            edges.sort(generateComparator((e) => `${e.from}-${e.to}`));
            break;
          case ':label':
            edges.sort(generateComparator((e) => e.labels?.[0]));
            break;
          default:
            edges.sort(generateComparator((e) => e.properties[edgeKey]?.[0]));
            break;
        }
      }
      // TODO: Preserve comment lines
      // Here, location.{start,end}.offset cannot be used because the value of offset ignores comment lines.
      // We use line and column instead of offset
      for(let node of nodes) {
        let end = node.location.end.line === node.location.start.line ?  node.location.end.line :  node.location.end.line - 1;
        newPG += oldPGlines.slice(node.location.start.line - 1, end).map((l) => l + "\n");
      }
      for(let edge of edges) {
        let end = edge.location.end.line === edge.location.start.line ?  edge.location.end.line :  edge.location.end.line - 1;
        newPG += oldPGlines.slice(edge.location.start.line - 1, end).map((l) => l + "\n");
      }
      editor.setValue(newPG);
      toastr.success(`Sorted!`, '', {preventDuplicates: true,  timeOut: 3000});
      sortModal.hide();
    });


    switch(viewMode) {
      case 'input-only':
        $('#input-only-btn').prop('checked', true);
        $('#input-area').resizable('disable');
        $('#input-area').css('width', '100%');
        $('#graph-pane').css('width', '0px');
        onResize(null, null);
        break;
      case 'view-only':
        $('#view-only-btn').prop('checked', true);
        $('#input-area').resizable('disable');
        $('#input-area').css('width', '0px');
        $('#graph-pane').css('width', '100%');
        onResize(null, null);
        break;
      default:
        $('#double-column-btn').prop('checked', true);
        break;
    }
    let tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'))
    let tooltipList = tooltipTriggerList.map(function (tooltipTriggerEl) {
      return new bootstrap.Tooltip(tooltipTriggerEl, {placement: 'bottom', customClass: 'tooltip-sandbox'});
    })

    $('.dropdown-item').on('mouseenter', (e) => {
      tooltipList.forEach((t) => t.hide());
    });

    $('.dropdown').on('click', (e) => {
      tooltipList.forEach((t) => t.hide());
    });

    if(!localStorage.getItem('saved-graph-' + localStorage.getItem('currentGraphName'))) {
      saveCurrentGraph();
    }

    loadSavedGraphs();
    showGraphName();
  }

});